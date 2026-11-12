<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Zscaler ZPA App Connector on AWS

> **Important:** This sample code is a non-production reference architecture. It's provided for demonstration and evaluation, and it isn't intended for production use as is. Before you use it with production workloads, review the AWS Identity and Access Management (IAM) policies, encryption settings, network controls, instance sizing, and patch schedules. Adapt them to your organization's security, compliance, and operational requirements, and have your own security team review the result.

## Overview

Zscaler Private Access (ZPA) provides users identity-based access to private applications without a VPN and without the applications being exposed to the internet. Instead, Zscaler **App Connectors** broker the access. They're virtual appliances that open **outbound-only** TLS tunnels to the Zscaler Zero Trust Exchange. Users reach private applications through the Zscaler cloud, which routes each request to the nearest healthy App Connector.

This AWS Cloud Development Kit (AWS CDK) app deploys a highly available App Connector fleet on AWS. The fleet has the following properties:

- **Two Availability Zones**, with the connectors in private subnets and no public IP addresses.
- **An Amazon EC2 Auto Scaling group**, configurable, with a default minimum of 2, maximum of 4, and desired capacity of 4.
- **The latest Zscaler Amazon Machine Image (AMI) from AWS Marketplace**, resolved when you deploy.
- **The provisioning key in AWS Secrets Manager**, never in code or in AWS CloudFormation state.
- **Weekly patching, one connector at a time**, so connectivity is never fully lost.
- **Amazon CloudWatch monitoring**, with alarms for the failure modes specific to the connector.
- **Administration through AWS Systems Manager Session Manager**, so the connectors open no inbound ports.

The App Connector is a single appliance role. This AWS CDK app automates its deployment, patching, AMI updates, and health monitoring on AWS.

## Architecture

The following diagram shows the connector fleet, the AWS services the stack uses, and the traffic flows.

![ZPA App Connectors in two Availability Zones connect SAP users to an SAP VPC through Zscaler and AWS Transit Gateway](architecture.png)

The editable source is [`architecture.drawio`](architecture.drawio), and [`architecture.svg`](architecture.svg) is a scalable copy. Open the `.drawio` file with the draw.io desktop app or the draw.io extension for Visual Studio Code.

The diagram shows the following flows:

- **User access:** Users run the Zscaler Client Connector, which connects them to the Zscaler Zero Trust Exchange. The Zero Trust Exchange sends each session to an App Connector.
- **Outbound only:** Each App Connector runs in a private subnet. It reaches the Zscaler cloud on TCP 443 through a NAT gateway, or through a centralized egress VPC.
- **Application access:** The connector reaches the SAP systems and other private applications through AWS Transit Gateway or Amazon Virtual Private Cloud (Amazon VPC) peering.
- **Supporting services:**
  - At boot, each connector reads the provisioning key from AWS Secrets Manager.
  - An AWS Key Management Service (AWS KMS) key encrypts the key and the logs.
  - The connectors send logs and metrics to Amazon CloudWatch, which sends alarms through Amazon Simple Notification Service (Amazon SNS).
  - AWS Systems Manager provides Session Manager access and the weekly patch window.
  - Each week, an Amazon EventBridge rule runs an AWS Lambda function. The function checks AWS Marketplace for a newer AMI and rolls it in. Failed runs land in an Amazon Simple Queue Service (Amazon SQS) dead-letter queue.

## Repository layout

The repository contains the following files:

```text
bin/cdk-zpa-connector.ts     App entry: loads the configuration, creates the stack
lib/config.ts                Typed configuration loader and validation (from cdk.json context)
lib/zpa-connector-stack.ts   The stack: IAM, security group, launch template, Auto Scaling group,
                             secret, patching, AMI updater, monitoring
lambda/zpa_ami_updater.py    Weekly latest-AMI check and rolling instance refresh
scripts/precheck.sh          Read-only prerequisite check (Linux, macOS, AWS CloudShell)
scripts/precheck.ps1         Read-only prerequisite check (Windows)
architecture.drawio          Editable architecture diagram (.png and .svg exported from it)
cdk.json                     Context defaults (the "zpa" block)
```

## Prerequisites

You need the following tools and AWS resources before you deploy.

### Tooling

Your workstation needs the following tools:

- **Node.js 22 or later**, with npm.
- **The AWS Command Line Interface (AWS CLI) version 2**, signed in to the target account (`aws sso login` or a configured profile).
- **The AWS CDK CLI.** It's a development dependency of this project, so you run it with `npx cdk`.

### AWS prerequisites that this app does not create

Put the following resources in place first. The precheck scripts (`scripts/precheck.sh` and `scripts/precheck.ps1`) verify them.

| Prerequisite | Requirement |
|---|---|
| **VPC** | An Amazon VPC with DNS support and DNS hostnames turned on, large enough for its subnets. For example, a /26 holds two /28 private subnets and two /28 public subnets for zonal NAT gateways. |
| **Private subnets** | Exactly two, in two different Availability Zones, each /28 or larger. See [Subnet sizing](#subnet-sizing). |
| **Outbound internet** | Each private subnet needs a default route to the internet. Use a regional NAT gateway, a zonal NAT gateway in each Availability Zone, or a centralized egress VPC through AWS Transit Gateway. A regional NAT gateway or a centralized egress VPC needs no public subnet in the connector VPC. Interface endpoints alone aren't enough, because the connector needs general outbound access to the Zscaler cloud. |
| **Routing to workloads** | Routes from the connector subnets to the private application VPCs, through Transit Gateway or VPC peering. Accept the attachments, and add the return routes. |
| **DNS** | The connector VPC must resolve the internal application domains. Use Amazon Route 53 Resolver conditional forwarding or a DNS forwarder. If the VPC uses your own DNS servers, add DNS egress to them on the connector security group after deployment (see Step 4.5). |
| **AWS Marketplace subscription** | Accept the Zscaler ZPA App Connector subscription, product code `by1wc5269g0048ix2nqvr0362`. You do this once for each account, on the console, because there's no API to accept the terms. Without it, the Auto Scaling group can't launch instances. The subscription is free on [the AWS Marketplace listing](https://aws.amazon.com/marketplace/pp?sku=by1wc5269g0048ix2nqvr0362). |
| **ZPA Admin Portal** | A provisioning key for a dedicated App Connector group. Size its reuse limit for the connectors that are connected, or disconnected but still retained by the tenant, not for the fleet size. See [Protect the ZPA tenant](#protect-the-zpa-tenant). |
| **Auto Scaling service-linked role** | `AWSServiceRoleForAutoScaling` must exist. The AWS KMS key policy names it, and AWS KMS rejects a policy that names a role that doesn't exist yet. AWS creates the role the first time you use an Auto Scaling group in the account. In a new account, create it once with `aws iam create-service-linked-role --aws-service-name autoscaling.amazonaws.com`. |

### Subnet sizing

Size each private subnet for what it holds. Amazon VPC reserves five addresses in every subnet, so a /28 leaves 11 usable addresses. With the default `maxCapacity` of 4, one /28 subnet holds the following:

- Up to four connectors, when the other Availability Zone is unavailable.
- One more connector while Amazon EC2 Auto Scaling replaces or rebalances instances.
- One network interface for the AMI updater Lambda function, which runs in the same subnets.
- One network interface each for a Route 53 Resolver outbound endpoint and a Transit Gateway attachment, if you place them in these subnets.

Use /27 or larger if you raise `maxCapacity`, or if you add interface VPC endpoints or other workloads to these subnets. Amazon VPC doesn't allow a subnet smaller than /28, so a /29 isn't an option. For details, see [Subnet CIDR blocks](https://docs.aws.amazon.com/vpc/latest/userguide/subnet-sizing.html) in the *Amazon VPC User Guide*.

## Deployment

The following steps deploy the stack and bring the connectors online.

### Step 0: Run the precheck (read-only)

The precheck verifies the prerequisites without changing anything. Run the version for your platform:

```bash
# Linux, macOS, or AWS CloudShell
scripts/precheck.sh --profile <profile> --region <region> --vpc <vpc-id> --subnets <subnet-a>,<subnet-b>
```

```powershell
# Windows
scripts\precheck.ps1 -Profile <profile> -Region <region> -Vpc <vpc-id> -Subnets "<subnet-a>,<subnet-b>"
```

### Step 1: Install and configure

The following command installs the project dependencies:

```bash
npm ci
```

Set your values in the `zpa` block of `cdk.json`, or pass `-c zpa:<key>=<value>` when you deploy.

### Step 2: Synthesize and review

The following command synthesizes the stack with your values:

```bash
npm run synth -- \
  -c zpa:account=<id> -c zpa:region=<region> -c zpa:vpcId=<vpc> \
  -c zpa:privateSubnetIds=<subnet-a>,<subnet-b> -c zpa:alarmEmail=<you@example.com>
```

The configuration loader validates the values and stops at the first problem. For example, it rejects a list that doesn't have exactly two subnets, or alarms turned on with no email address. The precheck confirms that the two subnets are in different Availability Zones.

### Step 3: Bootstrap and deploy

Each account and Region needs a one-time AWS CDK bootstrap. The following commands bootstrap, review, and deploy:

```bash
npx cdk bootstrap aws://<id>/<region>   # once for each account and Region
npx cdk diff
npx cdk deploy
```

Amazon SNS sends a subscription confirmation to `alarmEmail`. Confirm it, or the alarms deliver no email. A subscription confirmed from the email link can be unsubscribed by anyone who has a copy of an alarm email. To require AWS sign-in to unsubscribe, confirm it with the AWS CLI instead. Copy the `Token` value from the confirmation link, then run the following command:

```bash
aws --profile <profile> --region <region> sns confirm-subscription \
  --topic-arn <alarm-topic-arn> --token <Token-from-the-confirmation-link> \
  --authenticate-on-unsubscribe true
```

### Step 4: Populate the provisioning key

The stack creates the Secrets Manager secret with the placeholder value `REPLACE_WITH_ZPA_PROVISIONING_KEY`. Until you replace it, each new connector logs `[FATAL] Provisioning key missing or still the placeholder` to the EC2 console output and shuts down without starting the connector. Amazon EC2 Auto Scaling replaces it, so expect scaling notifications on the alarm topic until you add the key. Don't put the key on the command line, where it's saved in your shell history and visible in the process list. Either paste it into the secret in the Secrets Manager console, or save it to a file with a text editor and pass the file. The following commands put the key from a file, delete the file, and refresh the fleet:

```bash
aws --profile <profile> --region <region> secretsmanager put-secret-value \
  --secret-id zpa-connector --secret-string file://provisioning-key.txt
rm -f provisioning-key.txt    # on Windows: Remove-Item provisioning-key.txt

aws --profile <profile> --region <region> autoscaling start-instance-refresh \
  --auto-scaling-group-name <AsgName-from-outputs> \
  --preferences '{"MinHealthyPercentage":50,"InstanceWarmup":300}'
```

### Step 4.5: Add backend application and DNS egress (manual)

The stack's security group allows outbound traffic to the **Zscaler cloud** on TCP 443 only. It doesn't allow traffic to the **backend applications** that the fleet brokers to, or to your **DNS servers**. Only you know those ports and CIDRs. The rules for the SAP applications are always required. The DNS rule depends on how the VPC resolves names.

The App Connector **opens** the session to the SAP application. Without this rule, it drops its own outbound packets, and the application is unreachable even though enrollment succeeds. Allow only the ports that your ZPA application segments define, and only to the CIDRs of the systems behind them. Confirm both with the application owner, and keep the rules in step with the application segments. The following command adds the usual SAP ports for one SAP VPC, to the security group in the `SecurityGroupId` stack output. Replace or extend the ports to match your segments.

```bash
aws --profile <profile> --region <region> ec2 authorize-security-group-egress \
  --group-id <SecurityGroupId-from-outputs> \
  --ip-permissions \
    "IpProtocol=tcp,FromPort=3200,ToPort=3299,IpRanges=[{CidrIp=<SAP_VPC_CIDR>,Description=SAP dispatcher}]" \
    "IpProtocol=tcp,FromPort=3300,ToPort=3399,IpRanges=[{CidrIp=<SAP_VPC_CIDR>,Description=SAP gateway}]" \
    "IpProtocol=tcp,FromPort=3600,ToPort=3699,IpRanges=[{CidrIp=<SAP_VPC_CIDR>,Description=SAP message server}]" \
    "IpProtocol=tcp,FromPort=44300,ToPort=44300,IpRanges=[{CidrIp=<SAP_VPC_CIDR>,Description=SAP HTTPS}]"
```

Don't add an all-protocol rule to a whole supernet, and don't send backend egress to `0.0.0.0/0`. Either one lets a compromised connector reach far more than the applications it serves.

The connectors must resolve the DNS names of the target SAP systems. Check the DHCP options set of the connector VPC to decide whether you need a DNS rule:

- **AmazonProvidedDNS:** no rule is needed. Security groups don't filter traffic to the Amazon-provided DNS server. The connectors reach the Route 53 Resolver and its forwarding rules without a rule.
- **Your own DNS servers** (for example, Active Directory domain controllers or on-premises DNS): add UDP and TCP 53 egress to each DNS server. TCP 53 covers large responses.

The following command adds DNS egress to one DNS server. Repeat it for each server:

```bash
aws --profile <profile> --region <region> ec2 authorize-security-group-egress \
  --group-id <SecurityGroupId-from-outputs> \
  --ip-permissions "IpProtocol=udp,FromPort=53,ToPort=53,IpRanges=[{CidrIp=<DNS_SERVER_IP>/32,Description=DNS}]" \
                   "IpProtocol=tcp,FromPort=53,ToPort=53,IpRanges=[{CidrIp=<DNS_SERVER_IP>/32,Description=DNS}]"
```

Don't send DNS egress to `0.0.0.0/0`.

### Step 5: Verify

Check the fleet with the following steps:

- In the ZPA Admin Portal, choose **Private Infrastructure**, **App Connectors**. The connectors show as **connected** in the right group and location.
- In CloudWatch, the `/zpa/connector` log group receives a `messages` and a `user-data` stream for each instance. All alarms are in the **OK** state.
- Terminate one connector. The Auto Scaling group replaces it, and the new connector enrolls without manual steps.

### Redeploying: refresh the cached AMI

The AWS CDK caches the AWS Marketplace AMI lookup in `cdk.context.json` the first time you synthesize. It reuses that AMI ID on every later `cdk synth` and `cdk deploy`, even after Zscaler publishes a newer image. Between deployments, the AMI-updater Lambda function moves the running fleet to newer AMIs, through new launch template versions.

A redeploy with a stale cache makes CloudFormation write the older AMI back into the launch template. The next instance refresh or scale-out then launches the **older** image. Before any redeploy, clear the cached lookup with the following commands:

```bash
# List the context values. Note the number (#) of the entry whose key starts with "ami:account=".
npx cdk context

# Reset only that entry. Replace <N> with the number shown, or pass the full key in quotes.
npx cdk context --reset <N>

# Synthesize, and confirm that the launch template has the AMI ID you expect.
npx cdk synth
```

The following command shows the current AMI:

```bash
aws ec2 describe-images --owners aws-marketplace \
  --filters "Name=product-code,Values=<zpaProductCode>" "Name=state,Values=available" \
  --query "sort_by(Images,&CreationDate)[-1].[ImageId,Name,CreationDate]" --output table
```

Deleting `cdk.context.json` also works, but it clears the cached VPC lookup too. `cdk.context.json` is excluded from version control (`.gitignore`), because it holds account-specific values.

**Don't change the connector security group description**. CloudFormation can't change a security group description in place, so an edit replaces the group on every existing deployment. The new group doesn't have the backend egress you added in Step 4.5. The connectors then lose access to the applications until you add the rule again. Run `npx cdk diff` before every redeploy, and confirm that `ConnectorSg` isn't marked `replace`. The description still mentions DNS to `0.0.0.0/0`, which is out of date, but it stays unchanged for this reason.

### Parameters

The following table lists the context keys, their defaults, and what they control.

| Parameter (context key) | Required | Default | Description |
|---|---|---|---|
| `account` | **Yes** | | Target AWS account ID. |
| `region` | **Yes** | | AWS Region, for example `us-east-1`. |
| `vpcId` | **Yes** | | Existing VPC to deploy into. |
| `privateSubnetIds` | **Yes** | | Exactly two private subnets in two Availability Zones, as a comma-separated list or a JSON array. |
| `minCapacity` | No | `2` | High availability floor, one connector for each Availability Zone. |
| `maxCapacity` | No | `4` | Upper scaling bound. |
| `desiredCapacity` | No | `4` | Steady-state fleet size. |
| `instanceType` | No | `m5a.large` | Zscaler's production recommendation. For low traffic, `m5a.xlarge` and `t3.xlarge` also work. |
| `volumeSizeGiB` | No | `80` | Root gp3 volume. The AMI updater grows it if a future AMI needs more space. |
| `secretName` | No | `zpa-connector` | Provisioning-key secret. The stack creates it with a placeholder, so the name must not exist yet. It's retained when you delete the stack. |
| `encryptionKeyType` | No | `customer-managed` | Encryption for the secret, root volumes, log group, alarm topic, and dead-letter queue. `customer-managed` (default) uses one AWS KMS customer managed key with rotation. `aws-managed` uses AWS managed and AWS owned keys. It needs the `AWSServiceRoleForAutoScaling` role (see Prerequisites). |
| `patchGroup` | No | `zpa-sequential` | Tag that binds connectors to the one-at-a-time patch path. |
| `enableAmiUpdater` | No | `true` | Provision the weekly AMI-updater Lambda function and EventBridge rule. |
| `amiUpdaterInstanceRefresh` | No | `true` | Let the AMI updater start the rolling instance refresh, with automatic rollback. Set `false` for notify-only: the updater creates the new launch template version and notifies you, and you start the refresh after review. |
| `enablePatching` | No | `true` | Provision the weekly sequential Systems Manager Maintenance Window. |
| `enableAlarms` | No | `true` | Provision the CloudWatch alarms and the Amazon SNS topic. |
| `alarmEmail` | If alarms | | Email address subscribed to the alarm topic. Required when `enableAlarms=true`. |
| `patchWindowCron` | No | `cron(0 3 ? * SAT *)` | Patch Maintenance Window schedule, in UTC. The default is a placeholder. Set your own window, outside your peak SAP usage and away from `amiUpdaterCron`. |
| `amiUpdaterCron` | No | `cron(0 0 ? * SUN *)` | AMI check schedule, in UTC. |
| `zpaProductCode` | No | `by1wc5269g0048ix2nqvr0362` | AWS Marketplace product code of the Zscaler ZPA App Connector. |

## Key design decisions

The stack makes the following design decisions:

1. **An outbound-only security group, with two egress classes.** App Connectors need no inbound access, so the security group has **no inbound rule**. Egress is split into two classes:
   - **The Zscaler cloud (managed by the stack):** **TCP 443** to **`0.0.0.0/0`**, by design. Zscaler's firewall allowlist for ZPA lists only port 443 for App Connectors. Its destinations are about 1,300 CIDR ranges that change most months, far more than a security group or managed prefix list can hold. The connector reaches the *nearest* Zscaler broker or Service Edge, so a fixed CIDR list would also break connectivity. The stack doesn't open TCP 80, because Zscaler's allowlist doesn't list it. The Zscaler and AWS Deployment Guide still mentions TCP 80 in its security group step on page 65. Its own checklist on page 68 lists only TCP 443. The compensating controls are no inbound access, egress on the required ports only, and TLS on all outbound cloud traffic.
   - **The backend applications and DNS (manual, after deployment):** the ports and CIDRs of the private applications that the fleet brokers to. If the VPC doesn't use AmazonProvidedDNS, this class also includes UDP and TCP 53 to your DNS servers. The stack doesn't create these rules, because only the operator knows the values. The `ManualBackendEgressStep` stack output gives the security group ID and an example command (see Step 4.5). The Zscaler guide requires this egress in addition to the cloud ports. Scope it to the backend supernet and the DNS server addresses, not `0.0.0.0/0`.

2. **Session Manager for administration.** There's no SSH key, no bastion host, and no inbound port 22. Break-glass access is through Session Manager, which AWS CloudTrail audits.

3. **The latest AWS Marketplace AMI, at deployment and at run time.** The stack resolves the newest AMI by product code when you synthesize. The AMI-updater Lambda function keeps the running fleet current each week:
   - It builds each new launch template version from the version that the Auto Scaling group runs, then makes it the default version.
   - It starts an instance refresh pinned to the new version, at a minimum healthy percentage of 75 and a maximum of 125.
   - The refresh rolls back automatically if it fails, or if the enrollment-backoff or OAuth 401 alarm goes to `ALARM` while it runs. A connector that boots but can't enroll still passes EC2 health checks, so these alarms are what catch a bad AMI.
   - With `amiUpdaterInstanceRefresh=false`, the function stops after the new launch template version and the notification, so you approve each rollout yourself.
   - Both the lookup and the function filter on owner `aws-marketplace` and the Zscaler product code. So only Zscaler images published in AWS Marketplace qualify.
   - Before it changes anything, the function checks the image's integrity. See [AMI provenance and integrity](#ami-provenance-and-integrity).

   The synthesized result is cached in `cdk.context.json`. See [Redeploying: refresh the cached AMI](#redeploying-refresh-the-cached-ami).

4. **The provisioning key only in Secrets Manager.** The key never appears in the launch template, the AWS CDK code, or the CloudFormation state:
   - At boot, the user data reads the key through a role scoped to the exact secret ARN. The secret is retained when you delete the stack, so the key isn't lost.
   - With the default `customer-managed`, one AWS KMS key with automatic rotation encrypts five resources. They're the secret, the root volumes, the `/zpa/connector` log group, the alarm topic, and the dead-letter queue. The root volumes hold the key on disk under `/opt/zscaler/var`. The key policy lets the Amazon EC2 Auto Scaling service-linked role use the key.
   - With `-c zpa:encryptionKeyType=aws-managed`, the stack uses AWS managed and AWS owned keys instead. They're `aws/secretsmanager`, the account default Amazon Elastic Block Store (Amazon EBS) key, the CloudWatch Logs key, and the SQS key. Root volumes stay encrypted in both modes. When alarms are on, the stack still creates a small key for the alarm topic. CloudWatch alarms can't publish to a topic encrypted with the AWS managed `aws/sns` key.
   - **Automatic secret rotation is off, by design.** The value is a provisioning key that Zscaler issues and you manage in the ZPA Admin Portal. AWS can't rotate it. To change it, reissue it in the portal, run `put-secret-value`, and refresh the fleet.

5. **Patching one connector at a time.** A dedicated Systems Manager Maintenance Window runs `AWS-RunPatchBaseline` with `MaxConcurrency=1` and `MaxErrors=0`, against the `PatchGroup` tag. Each connector is patched and rebooted, and must return before the next one starts. In a fleet of 2, at most one Availability Zone loses its connector, and only briefly.

6. **A clean enrollment at boot, and an alarm for the backoff**. The AMI starts the connector at boot, and without a key the connector begins an interactive OAuth enrollment. It writes a one-time user code to `/etc/issue`, which the serial console, and so the EC2 console output, then shows. So the user data has two parts. A cloud-config `bootcmd` runs early in boot, before the network is online and so before the connector service starts. It masks the service for the instance's first boot only. The shell script then stops and masks the connector again, in case it started, and clears any enrollment state. No patch or package script can start it until the key is in place. After the key is written, the script clears the state once more and removes any user code from `/etc/issue`. Then it starts the connector, which reads the provisioning key. Without this step, the connector waits for an interactive sign-in and never enrolls. The user data doesn't retry enrollment. After 5 consecutive failures, a Zscaler App Connector enters a **6-hour backoff**. The enrollment-backoff alarm pages on the first occurrence. To recover, fix the cause, then restart the connector through Session Manager with `systemctl restart zpa-connector`.

7. **IMDSv2 required.** The launch template requires Instance Metadata Service Version 2 (`HttpTokens=required`).

8. **Signed agent packages.** The user data installs the AWS Systems Manager agent and the CloudWatch agent from AWS S3 buckets, not from a package repository. It verifies each package against the AWS public key before installing it. The check uses a temporary keyring and package database. It also matches the key fingerprint to the value in the AWS documentation. The SSM Agent key is in `assets/amazon-ssm-agent.gpg` and expires on 2027-11-25; replace it when AWS publishes the next one. If the SSM Agent package doesn't verify, the connector keeps the agent that's in the AMI and logs a `[WARN]` line. The CloudWatch agent is installed and started before the provisioning key is read. If its package doesn't verify, install or start, the connector never reads the key. It logs a `[FATAL]` line to the console and shuts down, and Amazon EC2 Auto Scaling replaces it. A connector that can't ship its logs doesn't join the tenant.

9. **A gp3 root volume.** Cost-efficient baseline storage with fixed IOPS. The AMI updater grows the volume if a newer AMI's snapshot is larger.

10. **Configuration that fails fast.** The typed configuration loader validates inputs when you synthesize. It checks for two subnets, a minimum capacity of at least 2, and an alarm email when alarms are on. So misconfigurations surface before any resource is created.

### AMI provenance and integrity

> **Zscaler owns and publishes the App Connector AMI.** Zscaler builds the image and is responsible for its contents. Zscaler distributes it through AWS Marketplace under product code `by1wc5269g0048ix2nqvr0362`, subject to Zscaler's license terms. AWS Marketplace hosts the image, so the AMI owner field shows the AWS Marketplace account (owner alias `aws-marketplace`), not a Zscaler account ID. This app doesn't change the image.

The stack checks the AMI at three points:

- **Selection.** The AWS CDK lookup and the AMI updater accept only images with owner `aws-marketplace`, the Zscaler product code, and state `available`. Only AWS can set the `aws-marketplace` owner alias, so a copied or shared image with the same product code doesn't qualify.
- **Before a refresh.** The AMI updater checks the chosen image again before it creates a launch template version. It must have the `aws-marketplace` owner alias, the Zscaler Marketplace product code, and an EBS root device, and it must not be past its deprecation time. On any failure, the function raises an error and changes nothing. The failed run lands in the dead-letter queue.
- **At boot.** Before the user data reads the provisioning key, it makes two checks. The instance's product codes, from the instance metadata, must include the Zscaler product code. The instance's own AMI must also have the `aws-marketplace` owner alias, which the user data reads with `ec2:DescribeImages`. A copy of the Marketplace AMI keeps the product code but not the owner alias, so the second check catches it. If either check fails, the connector never reads the key. It logs the failure to `/var/log/user-data.log` and the console, then shuts down. Amazon EC2 Auto Scaling replaces it, and the scaling notifications reach the alarm topic.

## Security

The following table lists the security controls.

| Control | Description |
|---|---|
| **No inbound access** | The connector security group has no inbound rules. App Connectors make outbound connections only. |
| **Restricted egress** | The stack allows egress on TCP 443 for the Zscaler cloud only. You add backend and, if required, DNS egress, scoped to known CIDRs. The 443 destination is `0.0.0.0/0` because Zscaler's App Connector destinations are about 1,300 CIDR ranges that change most months. The control is the port restriction and TLS, not the CIDR. |
| **Session Manager administration** | Administration through Session Manager, with no SSH, no bastion host, and no key pair. |
| **Scoped IAM** | The stack's own permissions are scoped to its resources. The instance role reads only the exact secret ARN, decrypts only with the stack key, and reads only the `/zpa/cloudwatch-agent/config` parameter. Its one unscoped permission is the read-only `ec2:DescribeImages` for the boot-time AMI owner check, because that action doesn't support resource-level permissions. It also has three AWS managed policies: `AmazonSSMManagedInstanceCore`, `CloudWatchAgentServerPolicy` and `AmazonSSMPatchAssociation`. These are broader than this app needs, for example `ssm:GetParameter` and CloudWatch Logs writes on all resources. AWS maintains them as the services change, which is why the stack uses them. To narrow the role further, replace them with your own policies and add a permissions boundary. The AMI-updater role can change only this stack's launch template and Auto Scaling group. Its `ec2:RunInstances` permission works only through this launch template. The image and security groups must come from the launch template itself (`ec2:IsLaunchTemplateResource`), and the image must be an AWS Marketplace image (`ec2:Owner`). Its `iam:PassRole` is limited to the connector role and to Amazon EC2. These conditions cover the resources in a launch, not the user data. A principal that can call `ec2:CreateLaunchTemplateVersion` on this launch template, including the updater function's code, can still change the user data. That's an accepted residual risk: limit who can change the launch template and the function (`lambda:UpdateFunctionCode`). |
| **Secret handling** | The provisioning key is held only in Secrets Manager, read at boot, and never in code or state. The secret is retained when you delete the stack. |
| **AMI provenance and integrity** | Zscaler owns and publishes the AMI through AWS Marketplace (owner alias `aws-marketplace`, product code `by1wc5269g0048ix2nqvr0362`). The stack checks the image at selection, before each AMI refresh, and at boot before the provisioning key is read. See [AMI provenance and integrity](#ami-provenance-and-integrity). |
| **Encryption at rest** | With the default `encryptionKeyType=customer-managed`, one AWS KMS customer managed key with rotation encrypts the secret, root volumes, log group, alarm topic, and dead-letter queue. With `aws-managed`, AWS managed and AWS owned keys are used instead. Root volumes are encrypted in both modes. |
| **cdk-nag** | Every `cdk synth` and `cdk deploy` runs the cdk-nag AWS Solutions rule pack. It writes a report to `cdk.out/AwsSolutions-*-NagReport.csv`. Each accepted finding carries an inline `NagSuppressions` reason next to the resource. Any new finding without a suppression fails the synth. |
| **Secret rotation** | **Off, by design.** Zscaler issues the provisioning key, and you manage it in the ZPA Admin Portal. AWS can't rotate it. To change it, reissue it in the portal, run `put-secret-value`, and refresh the fleet. |
| **IMDSv2 required** | The launch template requires IMDSv2 tokens. |
| **No public IP addresses** | The launch template sets `AssociatePublicIpAddress=false`, so connectors never get a public IP address, even in a subnet that assigns one automatically. |
| **Signed agent packages** | The SSM Agent and CloudWatch agent packages are verified against pinned AWS public key fingerprints before they're installed. A connector without a verified, running CloudWatch agent shuts down before it reads the key. See design decision 8. |
| **AMI-updater egress** | The AMI-updater Lambda function's security group allows only outbound TCP 443, to the AWS service APIs. |
| **KMS key policy conditions** | The key policy statements for CloudWatch alarms require `aws:SourceAccount` and an `aws:SourceArn` of an alarm in this account and Region. |
| **Administration and ZPA tenant** | See [Secure administration and operations](#secure-administration-and-operations) for Session Manager logging, who can start sessions, and the ZPA-side controls. |
| **Encryption in transit** | All connector traffic to the Zscaler cloud uses TLS. |
| **Continuous patching** | Weekly operating system patching and weekly AMI updates, both applied one connector at a time. |

## Secure administration and operations

The stack secures the AWS side. The following controls cover who can administer the connectors and the Zscaler side of the deployment. You set them up outside this app.

### Audit and limit Session Manager access

Session Manager sessions and Run Command commands run as root on a connector. So anyone who can use either one can read the provisioning key on its disk. So log every session, and allow sessions and commands only for the people who administer the connectors:

- **Log sessions.** In the Systems Manager console, choose **Session Manager**, **Preferences**. Send session logs to an encrypted CloudWatch Logs log group or Amazon S3 bucket, and turn on KMS encryption for session data. For details, see [Logging session activity](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-logging.html) in the *AWS Systems Manager User Guide*.
- **Limit who can start a session.** Grant `ssm:StartSession` only to a named administrator role, and only on the connectors. The connectors carry the tag `Application=zpa-connector`, so the following policy statement allows sessions on them alone:

```json
{
  "Effect": "Allow",
  "Action": "ssm:StartSession",
  "Resource": "arn:aws:ec2:<region>:<account-id>:instance/*",
  "Condition": { "StringEquals": { "ssm:resourceTag/Application": "zpa-connector" } }
}
```

Also allow `ssm:TerminateSession` and `ssm:ResumeSession` on the administrator's own sessions. Scope `ssm:SendCommand` the same way, with the same tag condition, because Run Command also runs as root. Don't grant `ssm:StartSession` or `ssm:SendCommand` on all instances to other roles in the account.

- **Limit who can read the console.** The EC2 console output and screenshot show what the instance prints on its serial console. That includes the login banner from `/etc/issue`. The user data removes the Zscaler OAuth user code from that banner, but grant `ec2:GetConsoleOutput` and `ec2:GetConsoleScreenshot` only to the administrators of the connectors. Many broad read-only policies include them.

- **Alert on changes to the agent configuration.** The CloudWatch agent reads its configuration from the `/zpa/cloudwatch-agent/config` parameter at boot. Anyone who can write that parameter can add the provisioning key file to the shipped logs. To get an alert when it changes, create an Amazon EventBridge rule on AWS CloudTrail `PutParameter`, `DeleteParameter` and `LabelParameterVersion` events, and match names that start with `/zpa/`. EventBridge can't publish to the alarm topic as deployed, because the topic's AWS KMS key doesn't allow `events.amazonaws.com`. Send the events to a separate topic, or add a key policy statement that allows `events.amazonaws.com` to use `kms:GenerateDataKey*` and `kms:Decrypt`. You can also deny those actions on `/zpa/*` to everyone except a deployment role, with a service control policy.

### Protect the ZPA tenant

A connector is only as trustworthy as the ZPA tenant that controls it. Follow the Zscaler guidance for the following controls:

- **A dedicated App Connector group** for this fleet, in each environment, so that application segments and policies for SAP use only these connectors.
- **Single sign-on and multi-factor authentication** for ZPA Admin Portal administrators, with administrator roles scoped to the minimum.
- **Monitoring for new enrollments.** Stream the ZPA audit logs and App Connector status to your security monitoring with Zscaler Log Streaming Service. Alert on connectors that enroll outside a deployment or a refresh.
- **A scoped provisioning key.** Keep the key in Secrets Manager only, and scope it as described in [Size and restrict the provisioning key](#size-and-restrict-the-provisioning-key).
- **Key revocation at clean-up.** When you delete the stack, delete the provisioning key in the ZPA Admin Portal. Also remove the connectors and the App Connector group. See [Clean up](#clean-up).

### Size and restrict the provisioning key

Every new EC2 instance enrolls as a new App Connector and uses one enrollment from the key's reuse limit. A fleet of 4 doesn't use 4 enrollments. It uses 4 at the first deployment, 4 more for each AMI refresh, and up to 4 more if a refresh rolls back. Each instance that Amazon EC2 Auto Scaling replaces uses 1 more. Patching reboots don't use any, because the user data runs only at first boot. A key whose limit equals the fleet size runs out at the first refresh. The new connectors then fail enrollment, and the refresh rolls back.

To keep the key useful to you and not to an attacker, apply the following controls:

- **Size the limit for the retention period.** A disconnected App Connector keeps its place in the tenant until the retention period ends. You set the retention period for disconnected connectors in the ZPA Admin Portal, for example 30 days. It's a global setting for the whole tenant. This behavior comes from the setting in our own ZPA tenant, not from Zscaler documentation, so confirm it in your tenant. So the limit must cover every connector that's connected, or disconnected but still retained, at the same time. Take a fleet of 4 and a 30-day period. One refresh leaves the 4 old connectors disconnected for 30 days, so 8 places are in use. A refresh that rolls back uses 4 more, and each replaced instance uses 1. A limit of about 16 covers one refresh a month with headroom. Add 4 for each extra refresh in the period, or delete the disconnected connectors after each refresh to free their places at once.
- **Restrict where the key can be used.** Set the key's IP address allow list to the public IP addresses of your connectors' outbound traffic. These are your NAT gateway Elastic IP addresses, or your centralized egress addresses. A copy of the key then can't enroll a connector from anywhere else.
- **Watch the usage count.** The ZPA Admin Portal shows how many times the key has been used. Alert on enrollments outside a deployment, a refresh, or a replacement.
- **Rotate the key before it runs out.** Create a new key for the same App Connector group, and update the secret. Then disable the old key. Before you delete an old key, confirm with Zscaler how that affects connectors that enrolled with it.

Zscaler also supports enrollment with a one-time OAuth user code that an administrator approves for each connector. This app uses the provisioning key, because an Auto Scaling group replaces instances with no one there to approve them. Approving codes automatically needs ZPA API credentials in the account, which can change the whole tenant. Zscaler's own Auto Scaling group templates make the same choice for automatic scale-out and instance refresh.

### Key file on the instance

The user data writes the key file `/opt/zscaler/var/provision_key` with mode `644`, the mode that the Zscaler AMI uses. The connector writes its own enrollment files, including its certificate and the encrypted key, the same way: mode `644` inside the `700` directory. The directory `/opt/zscaler/var` belongs to the `zscaler` service user with mode `700`, so no other non-root user can read files in it, whatever their mode. After the connector enrolls, it keeps an encrypted copy, `provision_key.crypt`, and the plain-text file is no longer there. The root volume is encrypted with the stack key. The remaining way to read the key is root access, through Session Manager or Run Command. That's why [Audit and limit Session Manager access](#audit-and-limit-session-manager-access) matters.

## Monitoring and alerting

The CloudWatch agent ships `/var/log/messages`, which holds the connector journal, and `/var/log/user-data.log` to the `/zpa/connector` log group, with host metrics. Its configuration is in Systems Manager Parameter Store at `/zpa/cloudwatch-agent/config`. Two metric filters, in the `ZPA/Connector` namespace, feed the alarms in the following table.

| Alarm | Condition | Severity |
|---|---|---|
| **Enrollment backoff** | The log shows `re-enrollment in 6 hours` once or more in any of the last three 5-minute periods | **Page.** A connector is stuck for up to 6 hours. |
| **Fleet under minimum** | `GroupInServiceInstances` under `minCapacity` for 5 consecutive minutes | **Page.** |
| **Repeated OAuth 401** | 3 or more OAuth 401 responses in one 10-minute period | **Notify.** Suspect the provisioning key. |
| **AMI updater errors** | The AMI-updater Lambda function returns an error in a 5-minute period | **Notify.** An integrity check or an AWS call failed. Check the function's log. |
| **AMI updater dead-letter queue** | One or more messages in the dead-letter queue | **Notify.** A run failed after its retries. |

Alarms publish to an Amazon SNS topic subscribed to `alarmEmail`. The ZPA Admin Portal remains the source of truth for connector health on the Zscaler side. These alarms catch the AWS side failures quickly.

## Cost estimate

The following table estimates the monthly cost of a fleet of 4 `m5a.large` connectors in one Region, at On-Demand prices. All amounts are in US dollars (USD), and prices vary by Region and usage.

| Component | Estimate | Basis |
|---|---|---|
| Amazon EC2 (4 m5a.large instances, all month) | About $250 to $280 | About $0.086 an hour, for 4 instances, for 730 hours |
| Amazon EBS (4 volumes of 80 GB gp3) | About $26 | $0.08 for each GB-month |
| NAT gateways (2) | About $65, plus data | $0.045 an hour, for 2 gateways, for 730 hours, plus processing |
| CloudWatch (logs, metrics, alarms) | About $5 to $10 | Connector logs and a few alarms |
| Lambda (AMI updater) | Less than $1 | Weekly invocation |
| Secrets Manager | About $0.40 | 1 secret |
| AWS KMS (default customer managed key; with `aws-managed`, only the alarm-topic key remains when alarms are on) | About $1, plus usage | $1 for each key-month, plus $0.03 for each 10,000 requests |
| **Total** | **About USD 350 to 390 a month** | Excludes cross-VPC and Transit Gateway data, and Zscaler licensing |

A fleet of 2 roughly halves the Amazon EC2 and Amazon EBS lines. For precise figures, use the [AWS Pricing Calculator](https://calculator.aws/). Zscaler ZPA licensing is separate, and isn't an AWS charge.

## Clean up

The following command deletes the stack:

```bash
npx cdk destroy
```

In the ZPA Admin Portal, delete the provisioning key, so that it can't enroll another connector. Then remove the connectors and the App Connector group.

The stack retains three resources on purpose: the provisioning-key secret, the AWS KMS customer managed key, and the `/zpa/connector` log group. Delete them separately when you no longer need them. The key has a waiting period before it's deleted. A redeploy fails while a retained secret or log group with the same name exists. Before you redeploy, delete the log group, and delete the secret or choose a different `secretName`.

## Notices

Customers are responsible for making their own independent assessment of the information in this Guidance. This Guidance: (a) is for informational purposes only, (b) represents AWS current product offerings and practices, which are subject to change without notice, and (c) does not create any commitments or assurances from AWS and its affiliates, suppliers or licensors. AWS products or services are provided "as is" without warranties, representations, or conditions of any kind, whether express or implied. AWS responsibilities and liabilities to its customers are controlled by AWS agreements, and this Guidance is not part of, nor does it modify, any agreement between AWS and its customers.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.

Zscaler, ZPA and Zscaler Private Access are trademarks of Zscaler, Inc. Use of the Zscaler App Connector AMI from AWS Marketplace is subject to Zscaler's own license terms and subscription.
