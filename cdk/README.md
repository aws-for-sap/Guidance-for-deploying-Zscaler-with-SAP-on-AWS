# Zscaler ZPA App Connector — CDK (placeholder)

AWS CDK (TypeScript) reference implementation for deploying a Zscaler ZPA App Connector fleet on AWS.

> **Placeholder scaffold.** This currently contains only a stub stack so the project synthesizes. The full implementation is being developed.

## Prerequisites

- Node.js 22.x and npm
- AWS CLI v2, authenticated to the target account
- AWS CDK (bundled as a dev dependency; run with `npx cdk`)

## Usage

```bash
npm install
npx cdk synth
```

## Planned scope

The completed application will provision:

- A 2-AZ Auto Scaling Group of Zscaler ZPA App Connectors in private subnets (configurable min/max/desired).
- The latest Zscaler Marketplace AMI, resolved at deploy time.
- The provisioning key sourced from AWS Secrets Manager.
- One-at-a-time weekly patching via an SSM Maintenance Window.
- CloudWatch monitoring and alarms.

Administration will be via AWS Systems Manager Session Manager (no inbound access).

All configuration values will be parameters — this repository contains no environment-specific data.
