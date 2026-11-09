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
    // accepted exception, documented here and in the README/L200/L300 guides.

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
    ], true);

    // ------------------------------------------------------------------
    // 5. Security group — NO ZPA inbound; egress 80/443 only
    // ------------------------------------------------------------------
    // The connector needs TWO distinct classes of outbound egress:
    //
    //   (a) TO THE ZSCALER CLOUD  — TCP 443/80 to 0.0.0.0/0 (managed here, below).
    //       Required for enrollment + the TLS broker tunnels. Zscaler does NOT
    //       publish a stable, enumerable IP allow-list: the connector reaches the
    //       NEAREST broker / Service Edge across Zscaler's global anycast cloud, and
    //       those endpoints change by region and over time. Zscaler's guidance is
    //       domain/port-based (outbound 443, no inbound), not CIDR-based, so pinning
    //       to fixed CIDRs would break connectivity. Per the Zscaler AWS Deployment
    //       Guide these are the mandatory outbound ports for cloud communication.
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
    //       output and the deployment guide's "Backend egress (post-deployment)"
    //       section. Do NOT bake a backend CIDR into this stack.
    // ------------------------------------------------------------------
    const sg = new ec2.SecurityGroup(this, 'ConnectorSg', {
      vpc,
      // Keep this description STABLE. CloudFormation cannot change a security group's
      // description in place: any edit REPLACES the group, which drops the manually
      // added backend egress rules (section (b) above) on every existing deployment.
      description: 'ZPA App Connector - outbound-only (80/443/DNS to 0.0.0.0/0, required for the Zscaler cloud). No inbound; admin via SSM Session Manager.',
      allowAllOutbound: false,
    });
    // (a) Zscaler cloud egress — managed by the CDK (required, no fixed CIDR list).
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'ZPA cloud (TLS tunnels + enrollment) - Zscaler publishes no fixed CIDR list');
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'ZPA cloud (bootstrap / CRL)');
    // DNS egress, scoped to the DNS servers the connector uses (never 0.0.0.0/0 by default).
    // Default: the VPC CIDR. The Amazon-provided VPC resolver (VPC+2) is not filtered by
    // security groups, so the in-VPC Route 53 Resolver and its outbound-endpoint forwarding
    // work either way. Set zpa:dnsServerCidrs when DHCP options point at DNS servers outside
    // the VPC. Rule changes update in place; the group description above must stay unchanged.
    const dnsCidrs = cfg.dnsServerCidrs.length > 0 ? cfg.dnsServerCidrs : [vpc.vpcCidrBlock];
    for (const cidr of dnsCidrs) {
      sg.addEgressRule(ec2.Peer.ipv4(cidr), ec2.Port.udp(53), `DNS to ${cidr}`);
      sg.addEgressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(53), `DNS (TCP fallback) to ${cidr}`);
    }
    // (b) Backend application egress is NOT created here — see manual step below.

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
    // 7. User data (boot sequence: clean OAuth state, then start the connector with the provisioning key)
    // ------------------------------------------------------------------
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -uo pipefail',
      'exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1',
      'echo "[START] $(date)"',
      // Region from IMDSv2 (token-based, matches the launch template's requireImdsv2)
      'TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
      'REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)',
      `SECRET_NAME=${cfg.secretName}`,
      'mkdir -p /root/.aws && printf "[default]\\nregion = %s\\n" "$REGION" > /root/.aws/config',
      '# Baseline OS + security patch',
      'yum update -y || true',
      'yum update --security -y || true',
      'yum install -y aws-cli jq curl unzip nc bind-utils || true',
      '# --- SSM agent: clean reinstall from S3 + wait for registration ---',
      'systemctl stop amazon-ssm-agent 2>/dev/null || true',
      'yum remove -y amazon-ssm-agent 2>/dev/null || true',
      'rm -rf /etc/amazon/ssm /var/lib/amazon/ssm',
      'mkdir -p /tmp/ssm && cd /tmp/ssm',
      'curl -O "https://s3.$REGION.amazonaws.com/amazon-ssm-$REGION/latest/linux_amd64/amazon-ssm-agent.rpm" || true',
      'if [ ! -s ./amazon-ssm-agent.rpm ]; then curl -O https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/linux_amd64/amazon-ssm-agent.rpm || true; fi',
      'yum install -y --nogpgcheck ./amazon-ssm-agent.rpm || true',
      'systemctl daemon-reload; systemctl enable amazon-ssm-agent; systemctl start amazon-ssm-agent || true',
      'for i in $(seq 1 24); do sleep 5; if systemctl is-active --quiet amazon-ssm-agent && [ -f /var/lib/amazon/ssm/registration ]; then echo "SSM registered after $((i*5))s"; break; fi; systemctl start amazon-ssm-agent 2>/dev/null || true; done',
      '# --- ZPA connector provisioning ---',
      'mkdir -p /opt/zscaler/etc /opt/zscaler/var',
      // nosemgrep: missing-template-string-indicator -- literal JSON in a single-quoted shell string, not a JS template literal
      `echo '{"connector":{"mode":"connector"}}' > /opt/zscaler/etc/config.json`,
      'chmod 644 /opt/zscaler/etc/config.json',
      '# Provisioning key from Secrets Manager (create file first, then populate - perms 644 as the AMI expects)',
      'touch /opt/zscaler/var/provision_key && chmod 644 /opt/zscaler/var/provision_key',
      'aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --region "$REGION" --query SecretString --output text > /opt/zscaler/var/provision_key',
      '# CRITICAL: clear stale device-code/OAuth enrollment state left by the AMI auto-start,',
      '# otherwise the connector resumes interactive OAuth ("enter code in browser") and never reads the key.',
      'rm -f /opt/zscaler/var/.zrhi /opt/zscaler/var/oauth_enrollment_stats.json',
      '# Start the connector fresh - it now reads the provisioning key on a clean state',
      'systemctl restart zpa-connector || systemctl start zpa-connector || true',
      '# CloudWatch agent (install from the S3 RPM - the RHEL9 Zscaler AMI has no yum entry for it)',
      'curl -o /tmp/amazon-cloudwatch-agent.rpm "https://amazoncloudwatch-agent.s3.amazonaws.com/redhat/amd64/latest/amazon-cloudwatch-agent.rpm" || true',
      'if [ ! -s /tmp/amazon-cloudwatch-agent.rpm ]; then curl -o /tmp/amazon-cloudwatch-agent.rpm "https://amazoncloudwatch-agent-$REGION.s3.$REGION.amazonaws.com/redhat/amd64/latest/amazon-cloudwatch-agent.rpm" || true; fi',
      'rpm -Uvh --nodeps /tmp/amazon-cloudwatch-agent.rpm || yum install -y --nogpgcheck /tmp/amazon-cloudwatch-agent.rpm || true',
      `/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c ssm:${CW_AGENT_PARAM} || true`,
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

    const lt = new ec2.LaunchTemplate(this, 'ConnectorLaunchTemplate', {
      machineImage: ami,
      instanceType: new ec2.InstanceType(cfg.instanceType),
      role,
      securityGroup: sg,
      requireImdsv2: true,
      userData,
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

      // Dedicated SG for the VPC-attached updater Lambda: no inbound, egress to
      // AWS APIs only (443). allowAllOutbound keeps it to the standard egress path.
      const updaterFnSg = new ec2.SecurityGroup(this, 'AmiUpdaterFnSg', {
        vpc,
        description: 'ZPA AMI-updater Lambda - outbound to AWS APIs only, no inbound',
        allowAllOutbound: true,
      });

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
          INSTANCE_REFRESH: 'true',
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
      updaterFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'RunInstancesViaOwnLaunchTemplate',
        actions: ['ec2:RunInstances'],
        resources: [
          ownLaunchTemplateArn,
          ec2Arn('instance'),
          ec2Arn('volume'),
          ec2Arn('network-interface'),
          ec2Arn('subnet'),
          ec2Arn('security-group'),
          ec2Arn('image', ''),     // Marketplace AMIs are owned by another account
          ec2Arn('snapshot', ''),  // the AMI's root snapshot
        ],
        conditions: { ArnLike: { 'ec2:LaunchTemplate': ownLaunchTemplateArn } },
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
        `(over and above 443/80 to the Zscaler cloud). Confirm the backend supernet CIDR + required ports with the app owner, then e.g.: ` +
        `aws ec2 authorize-security-group-egress --group-id ${sg.securityGroupId} --region ${cfg.region} ` +
        `--ip-permissions "IpProtocol=-1,IpRanges=[{CidrIp=<BACKEND_SUPERNET_CIDR>,Description=backend apps}]"`,
    });
    new cdk.CfnOutput(this, 'ActionRequired', {
      value: `1) Populate secret '${cfg.secretName}' with the ZPA provisioning key, then refresh the ASG.  2) Add backend app egress to SG ${sg.securityGroupId} (see ManualBackendEgressStep).`,
    });
  }
}
