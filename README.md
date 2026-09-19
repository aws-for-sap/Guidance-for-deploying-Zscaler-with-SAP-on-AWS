# Guidance for deploying Zscaler with SAP on AWS

This repository provides guidance and an AWS CDK reference implementation for deploying **Zscaler ZPA App Connectors** on AWS to provide zero-trust private access to SAP and other workloads.

> **Status: early / placeholder.** The CDK application here is a scaffold. Full guidance and the complete implementation are being developed.

## What this deploys

A highly-available Zscaler ZPA App Connector fleet on AWS:

- **Two Availability Zones**, private subnets
- **Auto Scaling** — configurable (default min 2 / max 4 / desired 4)
- **Latest Zscaler Marketplace AMI**, resolved automatically at deploy time
- **Provisioning key in AWS Secrets Manager** (never stored in code)
- **One-at-a-time weekly patching** so connectivity is never fully lost
- **CloudWatch monitoring** with alarms for the failure modes that matter

Administration is via **AWS Systems Manager Session Manager** — the connectors open no inbound ports, in line with Zscaler's outbound-only App Connector model.

## Prerequisites

You provide these before deploying (they are outside the scope of the CDK app):

1. A VPC (/24 or larger) with **two private subnets in two Availability Zones** and a **NAT gateway** for outbound internet access.
2. Network routes from the connector subnets to your private application VPCs (for example via AWS Transit Gateway or VPC peering).
3. DNS resolution for your internal application domains from the connector VPC.
4. An accepted **Zscaler ZPA App Connector** AWS Marketplace subscription.
5. A **provisioning key** created in the Zscaler ZPA Admin Portal.

## Repository layout

```
cdk/          AWS CDK (TypeScript) reference implementation (placeholder)
```

## Getting started

See `cdk/README.md` for how to configure and deploy the CDK application.

## Security

- The Zscaler provisioning key is held only in AWS Secrets Manager, never in source.
- Connectors are outbound-only; security groups open no inbound ports.
- All example values in this repository are placeholders — replace them with your own.

## License

See the `LICENSE` file. This guidance is provided as-is for reference.
