import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as fs from 'fs';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';
import { ZpaConfig } from './config';

export interface ZpaConnectorStackProps extends cdk.StackProps {
  cfg: ZpaConfig;
}

const LOG_GROUP_NAME = '/zpa/connector';
const CW_AGENT_PARAM = '/zpa/cloudwatch-agent/config';

export class ZpaConnectorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ZpaConnectorStackProps) {
    super(scope, id, props);
    const cfg = props.cfg;

    // ------------------------------------------------------------------
    // 1. Import the existing VPC + the two private subnets (2 AZs)
    // ------------------------------------------------------------------
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: cfg.vpcId });
    const subnets = cfg.privateSubnetIds.map((sid, i) =>
      ec2.Subnet.fromSubnetId(this, `PrivateSubnet${i + 1}`, sid),
    );
    const vpcSubnets: ec2.SubnetSelection = { subnets };

    // ------------------------------------------------------------------
    // 2. Provisioning-key secret — reference if it exists, else create empty
    //    (CDK never holds the key value; the user populates it post-deploy)
    // ------------------------------------------------------------------
    // We cannot conditionally look up at synth time, so we create/adopt a
    // managed empty secret. If one already exists with this name the deploy
    // will fail on create; use `secretName` that does not yet exist, OR set
    // adoptExistingSecret via context. To keep it simple and idempotent we
    // create it with a placeholder and RETAIN on delete.
    //
    // Encryption: 'aws-managed' uses AWS-managed keys (aws/secretsmanager for the
    // secret, and the AWS-owned CloudWatch Logs key for the log group) — the default,
    // no extra cost. 'customer-managed' provisions ONE dedicated KMS CMK with rotation
    // that encrypts BOTH the provisioning-key secret AND the /zpa/connector log group,
    // for stronger, self-owned, auditable control. This single toggle satisfies the
    // Holmes/cfn-guard SECRETSMANAGER and CLOUDWATCH_LOG_GROUP_ENCRYPTED checks when set.
    // KMS key-policy condition for the cloudwatch.amazonaws.com statements: only alarms in this
    // account and Region can use the key (aws:SourceAccount + aws:SourceArn).
    const cloudWatchAlarmSourceConditions = {
      StringEquals: { 'aws:SourceAccount': this.account },
      ArnLike: { 'aws:SourceArn': cdk.Arn.format({ service: 'cloudwatch', resource: 'alarm', resourceName: '*', arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME }, this) },
    };
    let secretKey: kms.Key | undefined;
    if (cfg.encryptionKeyType === 'customer-managed') {
      secretKey = new kms.Key(this, 'ProvisioningKeyCmk', {
        description: `CMK for the ZPA App Connector secret + logs (${cfg.secretName})`,
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        alias: `alias/${cfg.secretName}-secret`,
      });
      // Allow CloudWatch Logs to use the CMK to encrypt/decrypt the log group.
      // (Secrets Manager gets its grant automatically via secret.grantRead below.)
      secretKey.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': cdk.Arn.format(
              { service: 'logs', resource: 'log-group', resourceName: `${LOG_GROUP_NAME}:*`, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME },
              this,
            ),
          },
        },
      }));
      // Allow CloudWatch (alarm actions) to publish into the CMK-encrypted SNS topic.
      secretKey.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToUseKeyForSns',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: ['*'],
        // Only CloudWatch alarms in this account and Region (confused-deputy protection).
        conditions: cloudWatchAlarmSourceConditions,
      }));
      // Allow EC2 Auto Scaling to launch connectors with CMK-encrypted root volumes
      // (cdk-nag AwsSolutions-EC26) and to publish scaling notifications into the
      // CMK-encrypted SNS topic (AwsSolutions-AS3). The ASG launches instances as its
      // service-linked role, so the key policy must name that role directly. It is
      // created automatically the first time an ASG is used in the account; the
      // precheck scripts confirm it exists, because KMS rejects a key policy that
      // names a role that does not exist yet.
      const asgServiceLinkedRole = new iam.ArnPrincipal(cdk.Arn.format({
        service: 'iam', region: '', resource: 'role',
        resourceName: 'aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling',
      }, this));
      secretKey.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'AllowAutoScalingServiceLinkedRoleUseOfKey',
        principals: [asgServiceLinkedRole],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: ['*'],
      }));
      secretKey.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'AllowAutoScalingServiceLinkedRoleGrantsForEbs',
        principals: [asgServiceLinkedRole],
        actions: ['kms:CreateGrant'],
        resources: ['*'],
        conditions: { Bool: { 'kms:GrantIsForAWSResource': 'true' } },
      }));
    }

    const secret = new secretsmanager.Secret(this, 'ProvisioningKeySecret', {
      secretName: cfg.secretName,
      description: 'Zscaler ZPA App Connector provisioning key. Replace the placeholder with the real key from the ZPA Admin Portal.',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      secretStringValue: cdk.SecretValue.unsafePlainText('REPLACE_WITH_ZPA_PROVISIONING_KEY'),
      encryptionKey: secretKey,
    });
    NagSuppressions.addResourceSuppressions(secret, [{
      id: 'AwsSolutions-SMG4',
      reason: 'The value is a Zscaler-issued ZPA provisioning key managed in the ZPA Admin Portal, not an AWS credential. AWS cannot rotate a third-party SaaS key; rotation is a documented manual process (re-issue in ZPA, put-secret-value, refresh the fleet).',
    }]);
    // NOTE (security review — SECRETSMANAGER_ROTATION_ENABLED_CHECK):
    // Automatic rotation is deliberately NOT enabled on this secret. The value is a
    // Zscaler ZPA provisioning/enrollment key issued and managed in the ZPA Admin
    // Portal, not an AWS-native credential. It does not change on an AWS schedule and
    // AWS Secrets Manager cannot rotate a third-party SaaS enrollment key. Updating it
    // is a MANUAL activity: rotate/re-issue the key in the ZPA Admin Portal, then
    // `aws secretsmanager put-secret-value` and refresh the fleet. This finding is an
    // accepted exception, documented here, in the README Security section, and in the AWS
    // documentation topic for this guidance.

    // ------------------------------------------------------------------
    // 3. Latest Marketplace AMI (by product code, resolved at deploy time)
    // ------------------------------------------------------------------
    const ami = new ec2.LookupMachineImage({
      name: '*',
      filters: {
        'product-code': [cfg.zpaProductCode],
        'state': ['available'],
      },
      owners: ['aws-marketplace'],
    });

    // ------------------------------------------------------------------
    // 4. IAM role — SSM core + CloudWatch + patch, scoped secret read
    // ------------------------------------------------------------------
    const role = new iam.Role(this, 'ConnectorRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'ZPA App Connector instance role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMPatchAssociation'),
      ],
    });
    // Scoped provisioning-key read (tighter than the legacy Resource:*)
    secret.grantRead(role);
    // With a customer-managed key, grantRead already adds kms:Decrypt via the
    // secret's grant; make it explicit so the key policy is unambiguous.
    if (secretKey) {
      secretKey.grantDecrypt(role);
    }
    // Patch policy S3 bucket used by SSM QuickSetup patch policy
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::aws-quicksetup-patchpolicy-*'],
    }));
    // Boot-time AMI owner check (user data). DescribeImages supports no resource-level
    // permissions, so it needs Resource *. Read-only.
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'DescribeOwnAmiAtBoot',
      actions: ['ec2:DescribeImages'],
      resources: ['*'],
    }));
    // Allow reading the CW-agent config parameter
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [cdk.Arn.format({ service: 'ssm', resource: 'parameter', resourceName: CW_AGENT_PARAM.replace(/^\//, '') }, this)],
    }));
    NagSuppressions.addResourceSuppressions(role, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS-maintained service policies: AmazonSSMManagedInstanceCore (Session Manager / Run Command, replaces SSH), CloudWatchAgentServerPolicy (CloudWatch agent) and AmazonSSMPatchAssociation (Patch Manager). AWS updates them as the services change; inline copies would drift.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore',
          'Policy::arn:<AWS::Partition>:iam::aws:policy/CloudWatchAgentServerPolicy',
          'Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMPatchAssociation',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Read-only s3:GetObject on the AWS-created SSM Quick Setup patch-policy baseline buckets, whose names carry an account/region suffix that is not known at synth time.',
        appliesTo: ['Resource::arn:aws:s3:::aws-quicksetup-patchpolicy-*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Read-only ec2:DescribeImages for the boot-time AMI owner check. The action supports no resource-level permissions, so AWS requires Resource *.',
        appliesTo: ['Resource::*'],
      },
    ], true);

    // ------------------------------------------------------------------
    // 5. Security group — NO ZPA inbound; egress TCP 443 only
    // ------------------------------------------------------------------
    // The connector needs TWO distinct classes of outbound egress:
    //
    //   (a) TO THE ZSCALER CLOUD  — TCP 443 to 0.0.0.0/0 (managed here, below).
    //       Required for enrollment + the TLS broker tunnels. Zscaler's ZPA firewall
    //       allowlist (config.zscaler.com) lists only port 443 for App Connectors, across
    //       about 1,300 CIDR ranges that change most months: far more than a security
    //       group or managed prefix list can hold, so the destination is 0.0.0.0/0 and
    //       the control is the port plus TLS. TCP 80 was removed: the allowlist doesn't
    //       list it, the Zscaler AWS Deployment Guide checklist names only TCP/443, and a
    //       live connector used only 443.
    //       (security review — EC2_SECURITY_GROUP_EGRESS_OPEN_TO_WORLD_RULE:
    //       0.0.0.0/0 on these ports is the documented, accepted posture.)
    //
    //   (b) TO THE BACKEND APPLICATIONS — the ports/CIDRs of the private apps this
    //       fleet brokers to (e.g. RDP 3389, SSH 22, HTTPS 443 to server subnets).
    //       The App Connector INITIATES the session to the backend, so without this
    //       egress it drops its own SYN and the app is unreachable even though
    //       enrollment succeeds. The Zscaler AWS Deployment Guide (Deploy App
    //       Connectors, step 12) states egress must include "TCP/443 for ZPA
    //       communication and UDP/53 for DNS resolution, ALONG WITH ANY REQUIRED
    //       PORTS TO ACCESS THE APPLICATIONS THE APP CONNECTOR SUPPORTS."
    //
    //       This (b) egress is DELIBERATELY NOT created by the CDK: the backend
    //       CIDRs/ports are environment-specific and only known to the operator, and
    //       a wrong guess is worse than an explicit, reviewed manual rule. It is a
    //       MANUAL POST-DEPLOYMENT STEP — see the ManualBackendEgressStep stack
    //       output, README Step 4.5, and "Add SAP backend and DNS egress" in the AWS
    //       documentation topic. Do NOT bake a backend CIDR into this stack.
    // ------------------------------------------------------------------
    const sg = new ec2.SecurityGroup(this, 'ConnectorSg', {
      vpc,
      // Keep this description STABLE. CloudFormation cannot change a security group's
      // description in place: any edit REPLACES the group, which drops the manually
      // added backend egress rules (section (b) above) on every existing deployment.
      // The text still says 80/443/DNS from earlier versions. It is deliberately NOT
      // updated: changing it would replace the group. The rules below are authoritative.
      description: 'ZPA App Connector - outbound-only (80/443/DNS to 0.0.0.0/0, required for the Zscaler cloud). No inbound; admin via SSM Session Manager.',
      allowAllOutbound: false,
    });
    // (a) Zscaler cloud egress — managed by the CDK (required, no fixed CIDR list).
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'ZPA cloud (TLS tunnels + enrollment) - Zscaler publishes no fixed CIDR list');
    // DNS egress is NOT created here. With AmazonProvidedDNS the connector resolves
    // through the VPC resolver (VPC+2), which security groups do not filter, so no rule
    // is needed. If the VPC DHCP options point at your own DNS servers, add UDP and TCP 53
    // egress to those servers as part of the manual post-deployment step (b), so the
    // connectors can resolve the DNS names of the target SAP systems.
    // (b) Backend application egress (and any DNS egress) is NOT created here - see manual step below.

    // ------------------------------------------------------------------
    // 6. CloudWatch: log group + agent config in SSM Parameter Store
    // ------------------------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'ConnectorLogGroup', {
      logGroupName: LOG_GROUP_NAME,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Same deploy-time choice as the secret: with encryptionKeyType=customer-managed
      // the connector logs are encrypted with the dedicated CMK; otherwise the
      // AWS-owned CloudWatch Logs key (encryption at rest is always on either way).
      encryptionKey: secretKey,
    });
    const cwAgentConfig = {
      agent: { metrics_collection_interval: 60, run_as_user: 'root' },
      logs: {
        logs_collected: {
          files: {
            collect_list: [
              { file_path: '/var/log/messages', log_group_name: LOG_GROUP_NAME, log_stream_name: '{instance_id}/messages' },
              { file_path: '/var/log/user-data.log', log_group_name: LOG_GROUP_NAME, log_stream_name: '{instance_id}/user-data' },
            ],
          },
        },
      },
      metrics: {
        namespace: 'ZPA/Connector',
        append_dimensions: { InstanceId: '${aws:InstanceId}', AutoScalingGroupName: '${aws:AutoScalingGroupName}' },
        metrics_collected: {
          cpu: { measurement: ['cpu_usage_active'], totalcpu: true },
          mem: { measurement: ['mem_used_percent'] },
          disk: { measurement: ['used_percent'], resources: ['/'] },
          swap: { measurement: ['swap_used_percent'] },
        },
      },
    };
    new ssm.StringParameter(this, 'CwAgentConfigParam', {
      parameterName: CW_AGENT_PARAM,
      stringValue: JSON.stringify(cwAgentConfig),
      description: 'CloudWatch agent config for ZPA connectors (fleet-wide; edit and re-fetch to roll out)',
    });

    // ------------------------------------------------------------------
    // 7. User data (boot sequence: stop the connector, AMI checks, signed agents, then the key and the connector)
    // ------------------------------------------------------------------
    // Public key that signs the SSM Agent RPM, copied from the AWS Systems Manager User Guide
    // ("Verify the signature of SSM Agent"). It expires on 2027-11-25; replace it when AWS
    // publishes the next key. The fingerprint below is pinned and checked at boot.
    const ssmAgentSigningKey = fs.readFileSync(path.join(__dirname, '..', 'assets', 'amazon-ssm-agent.gpg'), 'utf8').replace(/\r\n/g, '\n').trim();
    // The shell script below runs late in boot (cloud-final), after the AMI's zpa-connector
    // service has already started and, with no key, created an OAuth user code in /etc/issue,
    // which the serial console then prints. So the user data is multipart: a cloud-config
    // bootcmd runs first, in cloud-init's network stage, which is ordered before
    // network-online.target, and so before zpa-connector (After=network-online.target). It masks
    // the service for this boot only, and only on the instance's first boot (cloud-init-per once).
    // The shell script unmasks it after the provisioning key is written.
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -uo pipefail',
      'exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1',
      'echo "[START] $(date)"',
      // Close the first-boot OAuth window before anything else. The AMI starts zpa-connector at
      // boot, before the provisioning key exists, and the connector begins device-code (OAuth)
      // enrollment. Stop it and mask it for this boot, so that no patch or package script can
      // start it again until the key is in place; clear the enrollment state it left behind.
      'systemctl stop zpa-connector 2>/dev/null || true',
      'systemctl mask --runtime zpa-connector 2>/dev/null || true',
      'rm -f /opt/zscaler/var/.zrhi /opt/zscaler/var/oauth_enrollment_stats.json',
      // Region from IMDSv2 (token-based, matches the launch template's requireImdsv2)
      'TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
      'REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)',
      // AMI integrity check: the instance must carry the Zscaler AWS Marketplace product code
      // before it receives the provisioning key. Fail closed: no key read, and the instance shuts
      // down so Amazon EC2 Auto Scaling replaces it (scaling notifications alert the operator).
      `EXPECTED_PRODUCT_CODE=${cfg.zpaProductCode}`,
      'PRODUCT_CODES=""; for i in 1 2 3 4 5; do PRODUCT_CODES=$(curl -s -f -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/product-codes) && break; sleep 2; done',
      'if ! grep -qxF "$EXPECTED_PRODUCT_CODE" <<< "$PRODUCT_CODES"; then echo "[FATAL] AMI integrity check failed: product code $EXPECTED_PRODUCT_CODE not found on this instance (got: $PRODUCT_CODES). Not reading the provisioning key. Shutting down."; shutdown -h now; exit 1; fi',
      'echo "[OK] AMI integrity check passed: AWS Marketplace product code $EXPECTED_PRODUCT_CODE"',
      `SECRET_NAME=${cfg.secretName}`,
      'mkdir -p /root/.aws && printf "[default]\\nregion = %s\\n" "$REGION" > /root/.aws/config',
      '# Baseline OS + security patch (signed packages from the AMI repositories)',
      'yum update -y || true',
      'yum update --security -y || true',
      'yum install -y aws-cli jq curl unzip nc bind-utils || true',
      // AMI owner check: the product code alone also passes a COPY of the Marketplace AMI. The
      // instance's own AMI must have the owner alias aws-marketplace, which only AWS can set.
      // Fail closed, before the key is read (needs ec2:DescribeImages on the instance role).
      'AMI_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/ami-id)',
      'AMI_OWNER=""; for i in 1 2 3 4 5; do AMI_OWNER=$(aws ec2 describe-images --region "$REGION" --image-ids "$AMI_ID" --query "Images[0].ImageOwnerAlias" --output text 2>/dev/null) && [ -n "$AMI_OWNER" ] && break; sleep 5; done',
      'if [ "$AMI_OWNER" != aws-marketplace ]; then echo "[FATAL] AMI owner check failed: $AMI_ID has owner alias [$AMI_OWNER], not aws-marketplace. Not reading the provisioning key. Shutting down."; shutdown -h now; exit 1; fi',
      'echo "[OK] AMI owner check passed: $AMI_ID is an AWS Marketplace image"',
      // Agent package signatures. Both agents come from AWS S3 buckets, not from a yum repository,
      // so each package is verified against an AWS public key whose fingerprint is pinned here
      // (from the AWS documentation) before it is installed. Verification uses a throwaway
      // keyring and rpm database, so nothing is added to the system trust store.
      'VERIFY_DIR=$(mktemp -d /tmp/zpa-verify.XXXXXX); export GNUPGHOME="$VERIFY_DIR/gnupg"; mkdir -m 700 "$GNUPGHOME"',
      // nosemgrep: missing-template-string-indicator -- {print $10; exit} is an awk program inside a shell command, not a JS placeholder
      `key_fpr() { gpg --batch --with-colons --import-options show-only --import "$1" 2>/dev/null | awk -F: '/^fpr/{print $10; exit}'; }`,
      `cat > "$VERIFY_DIR/amazon-ssm-agent.gpg" <<'ZPA_SSM_SIGNING_KEY'\n${ssmAgentSigningKey}\nZPA_SSM_SIGNING_KEY`,
      '# --- SSM agent: download, verify the embedded AWS signature, then clean reinstall + wait for registration ---',
      'SSM_FPR=1C5B395CBE5E74E2F1CA21592784DBF388D19D46',
      'curl -sfo "$VERIFY_DIR/amazon-ssm-agent.rpm" "https://s3.$REGION.amazonaws.com/amazon-ssm-$REGION/latest/linux_amd64/amazon-ssm-agent.rpm" || curl -sfo "$VERIFY_DIR/amazon-ssm-agent.rpm" https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/linux_amd64/amazon-ssm-agent.rpm || true',
      'SSM_OK=0; mkdir -p "$VERIFY_DIR/rpmdb"',
      'if [ "$(key_fpr "$VERIFY_DIR/amazon-ssm-agent.gpg")" = "$SSM_FPR" ] && rpmkeys --dbpath "$VERIFY_DIR/rpmdb" --import "$VERIFY_DIR/amazon-ssm-agent.gpg" && rpmkeys --dbpath "$VERIFY_DIR/rpmdb" -K "$VERIFY_DIR/amazon-ssm-agent.rpm" | grep -q "signatures OK"; then SSM_OK=1; fi',
      'if [ "$SSM_OK" = 1 ]; then echo "[OK] SSM Agent package signature verified (key 88D19D46)"; systemctl stop amazon-ssm-agent 2>/dev/null || true; yum remove -y amazon-ssm-agent 2>/dev/null || true; rm -rf /etc/amazon/ssm /var/lib/amazon/ssm; rpm -Uvh "$VERIFY_DIR/amazon-ssm-agent.rpm" || true; else echo "[WARN] SSM Agent package signature NOT verified: keeping the SSM Agent already in the AMI"; fi',
      'systemctl daemon-reload; systemctl enable amazon-ssm-agent; systemctl start amazon-ssm-agent || true',
      'for i in $(seq 1 24); do sleep 5; if systemctl is-active --quiet amazon-ssm-agent && [ -f /var/lib/amazon/ssm/registration ]; then echo "SSM registered after $((i*5))s"; break; fi; systemctl start amazon-ssm-agent 2>/dev/null || true; done',
      // CloudWatch agent: verified, installed and running BEFORE the provisioning key is read.
      // Fail closed: a connector that can't ship its logs never reads the key or enrolls, and
      // shuts down so Amazon EC2 Auto Scaling replaces it. The [FATAL] line reaches the EC2
      // console output (the agent that would ship it isn't running).
      '# --- CloudWatch agent: download, verify the AWS detached signature, install and start (the RHEL9 Zscaler AMI has no yum entry for it) ---',
      'CW_FPR=937616F3450B7D806CBD9725D58167303B789C72',
      'CW_BASE=https://amazoncloudwatch-agent.s3.amazonaws.com',
      'curl -sfo "$VERIFY_DIR/cw.rpm" "$CW_BASE/redhat/amd64/latest/amazon-cloudwatch-agent.rpm" || { CW_BASE="https://amazoncloudwatch-agent-$REGION.s3.$REGION.amazonaws.com"; curl -sfo "$VERIFY_DIR/cw.rpm" "$CW_BASE/redhat/amd64/latest/amazon-cloudwatch-agent.rpm"; } || true',
      'curl -sfo "$VERIFY_DIR/cw.rpm.sig" "$CW_BASE/redhat/amd64/latest/amazon-cloudwatch-agent.rpm.sig" || true',
      'curl -sfo "$VERIFY_DIR/cw.gpg" https://amazoncloudwatch-agent.s3.amazonaws.com/assets/amazon-cloudwatch-agent.gpg || true',
      'CW_OK=0; if [ "$(key_fpr "$VERIFY_DIR/cw.gpg")" = "$CW_FPR" ] && gpg --batch --import "$VERIFY_DIR/cw.gpg" 2>/dev/null && gpg --batch --status-fd 1 --verify "$VERIFY_DIR/cw.rpm.sig" "$VERIFY_DIR/cw.rpm" 2>/dev/null | grep -qF "[GNUPG:] VALIDSIG $CW_FPR "; then echo "[OK] CloudWatch agent package signature verified (key 3B789C72)"; rpm -Uvh --nodeps --replacepkgs "$VERIFY_DIR/cw.rpm" && CW_OK=1; fi',
      `if [ "$CW_OK" = 1 ] && /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c ssm:${CW_AGENT_PARAM}; then echo "[OK] CloudWatch agent installed and running"; else echo "[FATAL] CloudWatch agent not verified, installed or started. Not reading the provisioning key. Shutting down."; shutdown -h now; exit 1; fi`,
      'mkdir -p /opt/zscaler/etc /opt/zscaler/var',
      // nosemgrep: missing-template-string-indicator -- literal JSON in a single-quoted shell string, not a JS template literal
      `echo '{"connector":{"mode":"connector"}}' > /opt/zscaler/etc/config.json`,
      'chmod 644 /opt/zscaler/etc/config.json',
      '# Provisioning key from Secrets Manager (create file first, then populate - perms 644 as the AMI expects)',
      'touch /opt/zscaler/var/provision_key && chmod 644 /opt/zscaler/var/provision_key',
      'aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --region "$REGION" --query SecretString --output text > /opt/zscaler/var/provision_key',
      // Fail closed on a missing or placeholder key: a connector started without a valid key falls back
      // to OAuth enrollment and writes a one-time user code to /etc/issue. The mask is --runtime, so the
      // instance shuts down instead of staying up masked (a patch reboot would clear the mask).
      // The CloudWatch agent is already running here, so wait 15 seconds for it to ship the [FATAL] line.
      'if [ ! -s /opt/zscaler/var/provision_key ] || grep -qxF "REPLACE_WITH_ZPA_PROVISIONING_KEY" /opt/zscaler/var/provision_key; then echo "[FATAL] Provisioning key missing or still the placeholder. Not starting the connector. Shutting down in 15 seconds."; sleep 15; shutdown -h now; exit 1; fi',
      'echo "[OK] Provisioning key present"',
      '# Clear any OAuth enrollment state again (a package update could have started the service before the mask), then start the connector once on a clean state',
      'rm -f /opt/zscaler/var/.zrhi /opt/zscaler/var/oauth_enrollment_stats.json',
      '# Remove any OAuth user code the AMI wrote to /etc/issue (printed on the serial console); the connector enrolls with the key',
      'sed -i -e "/OAuth Token/d" -e "/enter the code/d" /etc/issue 2>/dev/null || true',
      'systemctl unmask --runtime zpa-connector 2>/dev/null || true',
      'systemctl restart zpa-connector || systemctl start zpa-connector || true',
      'rm -rf "$VERIFY_DIR"',
      'touch /var/log/user-data-completed',
      'echo "[END] $(date)"',
    );

    // ------------------------------------------------------------------
    // 8. Launch template + Auto Scaling Group (2 AZs, IMDSv2, one-at-a-time refresh)
    // ------------------------------------------------------------------
    // Alarm topic is created before the ASG so the ASG can send its scaling
    // notifications to it (cdk-nag AwsSolutions-AS3).
    let alarmTopic: sns.Topic | undefined;
    if (cfg.enableAlarms) {
      // SNS SSE (security review — SNS_ENCRYPTED_KMS / CKV_AWS_26 / EA004 / aristotle 280):
      // the topic is always encrypted at rest with a customer-managed key. With
      // encryptionKeyType=customer-managed the stack CMK is used. With aws-managed, a
      // small dedicated alarm-topic CMK is created instead of the AWS-managed aws/sns key:
      // CloudWatch alarms cannot publish to a topic encrypted with aws/sns, because that
      // key's policy cannot be changed to admit cloudwatch.amazonaws.com, so alarm
      // notifications would silently never arrive.
      let snsKey: kms.IKey | undefined = secretKey;
      if (!snsKey) {
        const alarmTopicKey = new kms.Key(this, 'AlarmTopicCmk', {
          description: 'CMK for the ZPA App Connector alarm SNS topic (CloudWatch alarms cannot use aws/sns)',
          enableKeyRotation: true,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          alias: `alias/${cfg.secretName}-alarm-topic`,
        });
        alarmTopicKey.addToResourcePolicy(new iam.PolicyStatement({
          sid: 'AllowCloudWatchAlarmsToUseKeyForSns',
          principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
          actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
          resources: ['*'],
          // Only CloudWatch alarms in this account and Region (confused-deputy protection).
          conditions: cloudWatchAlarmSourceConditions,
        }));
        // ASG scaling notifications (AwsSolutions-AS3) are published as the EC2 Auto
        // Scaling service-linked role; see the precheck scripts for its existence check.
        alarmTopicKey.addToResourcePolicy(new iam.PolicyStatement({
          sid: 'AllowAutoScalingServiceLinkedRoleToPublish',
          principals: [new iam.ArnPrincipal(cdk.Arn.format({
            service: 'iam', region: '', resource: 'role',
            resourceName: 'aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling',
          }, this))],
          actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
          resources: ['*'],
        }));
        snsKey = alarmTopicKey;
      }
      alarmTopic = new sns.Topic(this, 'AlarmTopic', {
        displayName: 'ZPA Connector Alarms',
        masterKey: snsKey,
      });
      alarmTopic.addSubscription(new subs.EmailSubscription(cfg.alarmEmail));
    }

    const bootUserData = new ec2.MultipartUserData();
    bootUserData.addPart(ec2.MultipartBody.fromRawBody({
      contentType: 'text/cloud-config; charset="utf-8"',
      body: [
        '#cloud-config',
        'bootcmd:',
        '  - [cloud-init-per, once, zpa-mask-connector, systemctl, mask, --runtime, --now, zpa-connector]',
      ].join('\n'),
    }));
    bootUserData.addUserDataPart(userData, ec2.MultipartBody.SHELL_SCRIPT, true);

    const lt = new ec2.LaunchTemplate(this, 'ConnectorLaunchTemplate', {
      machineImage: ami,
      instanceType: new ec2.InstanceType(cfg.instanceType),
      role,
      securityGroup: sg,
      requireImdsv2: true,
      // Connectors never get a public IP address, even if a subnet in privateSubnetIds
      // auto-assigns one. They reach the internet only through NAT or central egress.
      associatePublicIpAddress: false,
      userData: bootUserData,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(cfg.volumeSizeGiB, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          iops: 3000,
          deleteOnTermination: true,
          // cdk-nag AwsSolutions-EC26: the root volume holds the provisioning key
          // (/opt/zscaler/var/provision_key) and enrollment state, so it is always
          // encrypted. The stack CMK is used with encryptionKeyType=customer-managed;
          // otherwise the account's default EBS key (aws/ebs).
          encrypted: true,
          kmsKey: secretKey,
        }),
      }],
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'ConnectorAsg', {
      vpc,
      vpcSubnets,
      launchTemplate: lt,
      minCapacity: cfg.minCapacity,
      maxCapacity: cfg.maxCapacity,
      desiredCapacity: cfg.desiredCapacity,
      healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.seconds(900) }),
      // The FleetBelowMin alarm reads GroupInServiceInstances, which Amazon EC2 Auto Scaling
      // publishes only when group metrics collection is on. Without it the alarm sees no data,
      // treats missing data as breaching, and sits in ALARM permanently.
      groupMetrics: [new autoscaling.GroupMetrics(autoscaling.GroupMetric.IN_SERVICE_INSTANCES)],
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        // one connector at a time; each warms up before the next
        minInstancesInService: cfg.minCapacity - 1 < 1 ? 1 : cfg.minCapacity - 1,
        maxBatchSize: 1,
        pauseTime: cdk.Duration.minutes(5),
        waitOnResourceSignals: false,
      }),
      // cdk-nag AwsSolutions-AS3: send launch / terminate / failure events to the alarm topic.
      notifications: alarmTopic
        ? [{ topic: alarmTopic, scalingEvents: autoscaling.ScalingEvents.ALL }]
        : undefined,
    });
    if (!alarmTopic) {
      NagSuppressions.addResourceSuppressions(asg, [{
        id: 'AwsSolutions-AS3',
        reason: 'Alarms and notifications were explicitly disabled at deploy time (zpa:enableAlarms=false), so there is no topic to notify. Enable alarms for production.',
      }]);
    }
    cdk.Tags.of(asg).add('Name', 'zpa-connector');
    cdk.Tags.of(asg).add('Application', 'zpa-connector');
    // PatchGroup drives the sequential patch path — MUST propagate at launch
    cdk.Tags.of(asg).add('PatchGroup', cfg.patchGroup, { applyToLaunchedInstances: true });

    // ------------------------------------------------------------------
    // 9. Monitoring — SNS + alarms (optional)
    // ------------------------------------------------------------------
    // (alarmTopic is created in section 8, before the ASG.)
    if (alarmTopic) {
      // Log-metric filters -> custom metrics from the connector journal
      const backoffMetric = logGroup.addMetricFilter('EnrollmentBackoff', {
        metricNamespace: 'ZPA/Connector',
        metricName: 'EnrollmentBackoff',
        filterPattern: logs.FilterPattern.literal('"re-enrollment in 6 hours"'),
        metricValue: '1',
        defaultValue: 0,
      }).metric({ statistic: 'Sum', period: cdk.Duration.minutes(5) });

      const oauth401Metric = logGroup.addMetricFilter('OAuth401', {
        metricNamespace: 'ZPA/Connector',
        metricName: 'OAuth401',
        filterPattern: logs.FilterPattern.literal('"401" "zpa-oauth"'),
        metricValue: '1',
        defaultValue: 0,
      }).metric({ statistic: 'Sum', period: cdk.Duration.minutes(10) });

      // Alarm: fleet below minimum in-service instances
      new cloudwatch.Alarm(this, 'FleetBelowMinAlarm', {
        alarmDescription: 'ZPA connector in-service count below minimum',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/AutoScaling',
          metricName: 'GroupInServiceInstances',
          dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
          statistic: 'Minimum',
          period: cdk.Duration.minutes(1),
        }),
        threshold: cfg.minCapacity,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 5,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }).addAlarmAction(new cwactions.SnsAction(alarmTopic));

      // Alarm: enrollment backoff latched (a connector is stuck for up to 6h) — page
      new cloudwatch.Alarm(this, 'EnrollmentBackoffAlarm', {
        alarmDescription: 'ZPA connector entered 6-hour enrollment backoff',
        metric: backoffMetric,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        // One backoff line in any of the last three 5-minute periods pages. A single
        // occurrence is the event that matters: the connector is then stuck for up to 6 hours.
        evaluationPeriods: 3,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cwactions.SnsAction(alarmTopic));

      // Alarm: repeated OAuth 401 — suspect key
      new cloudwatch.Alarm(this, 'OAuth401Alarm', {
        alarmDescription: 'Repeated ZPA OAuth 401 - suspect provisioning key',
        metric: oauth401Metric,
        threshold: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        // 3 or more OAuth 401 lines in one 10-minute period (the metric period is 10 minutes).
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cwactions.SnsAction(alarmTopic));
    }

    // ------------------------------------------------------------------
    // 10. Patching — standalone weekly sequential Maintenance Window (optional)
    // ------------------------------------------------------------------
    if (cfg.enablePatching) {
      const mwRole = new iam.Role(this, 'MaintenanceWindowRole', {
        assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonSSMMaintenanceWindowRole')],
      });
      NagSuppressions.addResourceSuppressions(mwRole, [{
        id: 'AwsSolutions-IAM4',
        reason: 'AmazonSSMMaintenanceWindowRole is the AWS-defined service role policy for SSM Maintenance Windows to run patch tasks.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonSSMMaintenanceWindowRole'],
      }]);

      const mw = new ssm.CfnMaintenanceWindow(this, 'PatchWindow', {
        name: `zpa-connector-patch-${this.region}`,
        description: 'Weekly sequential (one-at-a-time) patching for ZPA connectors',
        schedule: cfg.patchWindowCron,
        duration: 4,
        cutoff: 1,
        allowUnassociatedTargets: false,
        scheduleTimezone: 'UTC',
      });

      const mwTarget = new ssm.CfnMaintenanceWindowTarget(this, 'PatchTarget', {
        windowId: mw.ref,
        resourceType: 'INSTANCE',
        targets: [{ key: 'tag:PatchGroup', values: [cfg.patchGroup] }],
        name: 'zpa-connectors',
      });

      new ssm.CfnMaintenanceWindowTask(this, 'PatchTask', {
        windowId: mw.ref,
        taskArn: 'AWS-RunPatchBaseline',
        taskType: 'RUN_COMMAND',
        priority: 1,
        // ONE AT A TIME — the whole point for ZPA HA
        maxConcurrency: '1',
        maxErrors: '0',
        serviceRoleArn: mwRole.roleArn,
        targets: [{ key: 'WindowTargetIds', values: [mwTarget.ref] }],
        taskInvocationParameters: {
          maintenanceWindowRunCommandParameters: {
            parameters: { Operation: ['Install'], RebootOption: ['RebootIfNeeded'] },
          },
        },
      });
    }

    // ------------------------------------------------------------------
    // 11. AMI updater — weekly latest-AMI check + rolling refresh (optional)
    // ------------------------------------------------------------------
    if (cfg.enableAmiUpdater) {
      // Dead-letter queue for failed async invocations
      // (security review — LAMBDA_DLQ_CHECK). Encrypted with the CMK when
      // customer-managed, otherwise the SQS-managed key (SSE always on).
      const updaterDlq = new sqs.Queue(this, 'AmiUpdaterDlq', {
        queueName: `zpa-ami-updater-dlq-${this.region}`,
        retentionPeriod: cdk.Duration.days(14),
        enforceSSL: true,
        encryption: secretKey ? sqs.QueueEncryption.KMS : sqs.QueueEncryption.KMS_MANAGED,
        encryptionMasterKey: secretKey,
      });

      // Dedicated SG for the VPC-attached updater Lambda: no inbound, and outbound TCP 443 only
      // (the AWS service APIs). DNS goes to the VPC resolver, which security groups don't filter.
      // The description is unchanged so existing stacks update the rules in place.
      const updaterFnSg = new ec2.SecurityGroup(this, 'AmiUpdaterFnSg', {
        vpc,
        description: 'ZPA AMI-updater Lambda - outbound to AWS APIs only, no inbound',
        allowAllOutbound: false,
      });
      updaterFnSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'AWS service APIs (HTTPS)');

      // Alarms the instance refresh watches. If one goes to ALARM during a refresh, Amazon EC2
      // Auto Scaling rolls the refresh back. Both treat missing data as not breaching, so they are
      // OK when a refresh starts. FleetBelowMin is not used: an instance refresh intentionally
      // replaces instances, and that alarm must page rather than block.
      const rollbackAlarms = ['EnrollmentBackoffAlarm', 'OAuth401Alarm']
        .map((id) => this.node.tryFindChild(id) as cloudwatch.Alarm | undefined)
        .filter((a): a is cloudwatch.Alarm => a !== undefined);

      const updaterFn = new lambda.Function(this, 'AmiUpdaterFn', {
        functionName: `zpa-ami-updater-${this.region}`,
        // cdk-nag AwsSolutions-L1: latest Python runtime available in this CDK version.
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: 'zpa_ami_updater.lambda_handler',
        code: lambda.Code.fromInline(fs.readFileSync(path.join(__dirname, '..', 'lambda', 'zpa_ami_updater.py'), 'utf8')),
        timeout: cdk.Duration.seconds(120),
        environment: {
          LAUNCH_TEMPLATE_ID: lt.launchTemplateId!,
          ASG_NAME: asg.autoScalingGroupName,
          ZPA_PRODUCT_CODE: cfg.zpaProductCode,
          // Weekly automatic rollout of a new AMI. Set amiUpdaterInstanceRefresh=false for
          // notify-only: the function still creates the new launch template version and sends
          // the notification, and an operator starts the refresh after review.
          INSTANCE_REFRESH: cfg.amiUpdaterInstanceRefresh ? 'true' : 'false',
          ROLLBACK_ALARMS: rollbackAlarms.map((a) => a.alarmName).join(','),
          SNS_TOPIC_ARN: alarmTopic?.topicArn ?? '',
        },
        // security review — LAMBDA_CONCURRENCY_CHECK: cap concurrency. This function
        // runs once a week on a schedule; a single reserved execution is ample and
        // prevents it ever consuming unreserved account concurrency.
        reservedConcurrentExecutions: 1,
        // security review — LAMBDA_DLQ_CHECK: route failed async invocations to the DLQ.
        deadLetterQueue: updaterDlq,
        // security review — LAMBDA_INSIDE_VPC: run inside the VPC on the same private
        // subnets as the connectors. The function reaches the EC2/ASG control-plane
        // APIs via the account's VPC endpoints / NAT egress (same path the connectors
        // use). It talks only to AWS APIs, so it needs no inbound and its SG allows
        // all outbound (443 to the AWS endpoints).
        vpc,
        vpcSubnets,
        securityGroups: [updaterFnSg],
      });
      updaterFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'DescribeEc2Images',
        // Describe* has no resource-level scoping in EC2/Auto Scaling — it must be '*'. Read-only.
        actions: ['ec2:DescribeImages', 'ec2:DescribeLaunchTemplateVersions', 'autoscaling:DescribeAutoScalingGroups'],
        resources: ['*'],
      }));
      // StartInstanceRefresh with a DesiredConfiguration launch template makes Auto
      // Scaling run an EC2 RunInstances dry run AS THE CALLER, so the updater needs
      // ec2:RunInstances and iam:PassRole for the connector role. Both are fenced to
      // this stack: RunInstances only through this launch template, tagging only as
      // part of that launch, and PassRole only for the connector role, only to EC2.
      // Resources are listed by type (not '*') so no write action is unconstrained
      // (security review CKV_AWS_111), and the ec2:LaunchTemplate condition limits every
      // one of them to launches through this stack's launch template.
      const ec2Arn = (resource: string, account = this.account) =>
        cdk.Arn.format({ service: 'ec2', resource, resourceName: '*', account }, this);
      const ownLaunchTemplateArn = cdk.Arn.format({ service: 'ec2', resource: 'launch-template', resourceName: lt.launchTemplateId! }, this);
      // Resources the Auto Scaling group itself supplies (the subnet and the network interface it
      // creates there), plus the instance and volumes it launches: only through this launch template.
      updaterFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'RunInstancesViaOwnLaunchTemplate',
        actions: ['ec2:RunInstances'],
        resources: [
          ownLaunchTemplateArn,
          ec2Arn('instance'),
          ec2Arn('volume'),
          ec2Arn('network-interface'),
          ec2Arn('subnet'),
          ec2Arn('snapshot', ''),  // the AMI's root snapshot
        ],
        conditions: { ArnLike: { 'ec2:LaunchTemplate': ownLaunchTemplateArn } },
      }));
      // The image and security groups must come from the launch template itself
      // (ec2:IsLaunchTemplateResource), so a RunInstances call can't override them. The image must
      // also be an AWS Marketplace image (ec2:Owner).
      updaterFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'RunInstancesLaunchTemplateImageAndSg',
        actions: ['ec2:RunInstances'],
        resources: [ec2Arn('security-group')],
        conditions: {
          ArnLike: { 'ec2:LaunchTemplate': ownLaunchTemplateArn },
          Bool: { 'ec2:IsLaunchTemplateResource': 'true' },
        },
      }));
      updaterFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'RunInstancesMarketplaceImageOnly',
        actions: ['ec2:RunInstances'],
        resources: [ec2Arn('image', '')],  // Marketplace AMIs are owned by another account
        conditions: {
          ArnLike: { 'ec2:LaunchTemplate': ownLaunchTemplateArn },
          Bool: { 'ec2:IsLaunchTemplateResource': 'true' },
          StringEquals: { 'ec2:Owner': 'aws-marketplace' },
        },
      }));
      updaterFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'TagOnlyDuringRunInstances',
        actions: ['ec2:CreateTags'],
        resources: [ec2Arn('instance'), ec2Arn('volume'), ec2Arn('network-interface')],
        conditions: { StringEquals: { 'ec2:CreateAction': 'RunInstances' } },
      }));
      updaterFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'PassConnectorRoleToEc2',
        actions: ['iam:PassRole'],
        resources: [role.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
      }));
      updaterFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'ModifyOwnLaunchTemplate',
        // security review — CKV_AWS_111: scope the WRITE actions to this stack's
        // launch template, not Resource:*.
        actions: ['ec2:CreateLaunchTemplateVersion', 'ec2:ModifyLaunchTemplate'],
        resources: [cdk.Arn.format({ service: 'ec2', resource: 'launch-template', resourceName: lt.launchTemplateId! }, this)],
      }));
      updaterFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'RefreshOwnAsg',
        // security review — CKV_AWS_111: scope the autoscaling actions to this ASG.
        actions: ['autoscaling:StartInstanceRefresh', 'autoscaling:DescribeInstanceRefreshes'],
        resources: [cdk.Arn.format(
          { service: 'autoscaling', resource: 'autoScalingGroup', resourceName: `*:autoScalingGroupName/${asg.autoScalingGroupName}`, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME },
          this,
        )],
      }));
      if (alarmTopic) alarmTopic.grantPublish(updaterFn);
      if (rollbackAlarms.length > 0) {
        // Read access to the two rollback alarms only.
        updaterFn.addToRolePolicy(new iam.PolicyStatement({
          sid: 'DescribeRollbackAlarms',
          actions: ['cloudwatch:DescribeAlarms'],
          resources: rollbackAlarms.map((a) => a.alarmArn),
        }));
      }
      if (alarmTopic) {
        // Alarm: the AMI updater failed (Lambda errors) or a failed run reached the dead-letter queue.
        new cloudwatch.Alarm(this, 'AmiUpdaterErrorsAlarm', {
          alarmDescription: 'ZPA AMI updater Lambda function returned an error',
          metric: updaterFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }).addAlarmAction(new cwactions.SnsAction(alarmTopic));
        new cloudwatch.Alarm(this, 'AmiUpdaterDlqAlarm', {
          alarmDescription: 'ZPA AMI updater dead-letter queue has messages',
          metric: updaterDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }).addAlarmAction(new cwactions.SnsAction(alarmTopic));
      }
      NagSuppressions.addResourceSuppressions(updaterFn, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWS-maintained Lambda service policies: AWSLambdaBasicExecutionRole (CloudWatch Logs) and AWSLambdaVPCAccessExecutionRole (ENI management, required because the function runs inside the VPC).',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'ec2:DescribeImages, ec2:DescribeLaunchTemplateVersions and autoscaling:DescribeAutoScalingGroups do not support resource-level permissions (read-only). ec2:RunInstances on the instance/volume/network-interface/subnet/security-group/image/snapshot resource types is fenced by an ec2:LaunchTemplate condition to this stack\'s launch template, and ec2:CreateTags on instance/volume/network-interface by ec2:CreateAction=RunInstances; both are required by the RunInstances dry run Auto Scaling performs for StartInstanceRefresh with a DesiredConfiguration. The autoscaling ARN wildcard is only the ASG UUID segment; the resource is pinned to this stack\'s ASG name. kms:GenerateDataKey* is the CDK grant for the stack CMK only. iam:PassRole is limited to the connector role and to ec2.amazonaws.com.',
          appliesTo: [
            'Resource::*',
            { regex: '/^Resource::arn:<AWS::Partition>:autoscaling:.*:autoScalingGroup:\\*:autoScalingGroupName\\/.*$/g' },
            { regex: '/^Resource::arn:<AWS::Partition>:ec2:[^:]*:[^:]*:(instance|volume|network-interface|subnet|security-group|image|snapshot)\\/\\*$/g' },
            'Action::kms:GenerateDataKey*',
          ],
        },
      ], true);

      new events.Rule(this, 'AmiUpdaterSchedule', {
        ruleName: `zpa-ami-updater-weekly-${this.region}`,
        description: 'Weekly check for a newer ZPA Marketplace AMI',
        schedule: events.Schedule.expression(cfg.amiUpdaterCron),
        targets: [new targets.LambdaFunction(updaterFn)],
      });
    }

    // ------------------------------------------------------------------
    // 12. Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'AsgName', { value: asg.autoScalingGroupName });
    new cdk.CfnOutput(this, 'LaunchTemplateId', { value: lt.launchTemplateId! });
    new cdk.CfnOutput(this, 'SecretArn', { value: secret.secretArn });
    if (secretKey) {
      new cdk.CfnOutput(this, 'SecretKmsKeyArn', { value: secretKey.keyArn });
    }
    new cdk.CfnOutput(this, 'SecurityGroupId', { value: sg.securityGroupId });
    new cdk.CfnOutput(this, 'LogGroup', { value: LOG_GROUP_NAME });
    // Manual post-deployment step: the operator must add backend application egress
    // (the ports/CIDRs of the private apps this fleet brokers to). The CDK cannot
    // know these — see the SG comment and the deployment guide. Example command is
    // emitted here so it appears in `cdk deploy` output and `describe-stacks`.
    new cdk.CfnOutput(this, 'ManualBackendEgressStep', {
      value:
        `POST-DEPLOY (manual): add backend app egress to SG ${sg.securityGroupId}. ` +
        `The connector INITIATES sessions to backends, so it needs egress to the app ports/CIDRs it serves ` +
        `(over and above TCP 443 to the Zscaler cloud). If the VPC DHCP options use your own DNS servers instead of AmazonProvidedDNS, ` +
        `also add UDP and TCP 53 egress to those servers so the connector can resolve the SAP host names. ` +
        `Allow only the ports your ZPA application segments use, to the backend CIDR, for example the SAP ports: ` +
        `aws ec2 authorize-security-group-egress --group-id ${sg.securityGroupId} --region ${cfg.region} --ip-permissions ` +
        // nosemgrep: missing-template-string-indicator -- [{CidrIp=...}] is AWS CLI shorthand syntax in the example command, not a JS placeholder
        `"IpProtocol=tcp,FromPort=3200,ToPort=3299,IpRanges=[{CidrIp=<SAP_CIDR>,Description=SAP dispatcher}]" ` +
        // nosemgrep: missing-template-string-indicator -- [{CidrIp=...}] is AWS CLI shorthand syntax in the example command, not a JS placeholder
        `"IpProtocol=tcp,FromPort=3300,ToPort=3399,IpRanges=[{CidrIp=<SAP_CIDR>,Description=SAP gateway}]" ` +
        // nosemgrep: missing-template-string-indicator -- [{CidrIp=...}] is AWS CLI shorthand syntax in the example command, not a JS placeholder
        `"IpProtocol=tcp,FromPort=3600,ToPort=3699,IpRanges=[{CidrIp=<SAP_CIDR>,Description=SAP message server}]" ` +
        // nosemgrep: missing-template-string-indicator -- [{CidrIp=...}] is AWS CLI shorthand syntax in the example command, not a JS placeholder
        `"IpProtocol=tcp,FromPort=44300,ToPort=44300,IpRanges=[{CidrIp=<SAP_CIDR>,Description=SAP HTTPS}]". Never 0.0.0.0/0.`,
    });
    new cdk.CfnOutput(this, 'ActionRequired', {
      value: `1) Populate secret '${cfg.secretName}' with the ZPA provisioning key, then refresh the ASG.  2) Add backend app egress, and DNS egress if you use your own DNS servers, to SG ${sg.securityGroupId} (see ManualBackendEgressStep).`,
    });
  }
}
