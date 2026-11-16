#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ZpaConnectorStack } from '../lib/zpa-connector-stack';
import { loadZpaConfig } from '../lib/config';

const app = new cdk.App();

// Config comes from cdk.json context ("zpa": {...}), overridable with -c zpa:<key>=<value>.
const cfg = loadZpaConfig(app);

new ZpaConnectorStack(app, 'ZpaConnectorStack', {
  env: { account: cfg.account, region: cfg.region },
  stackName: `zpa-connector-${cfg.region}`,
  description: 'Zscaler ZPA App Connector fleet: 2-AZ ASG, Secrets Manager key, weekly sequential patching, CloudWatch monitoring',
  cfg,
  terminationProtection: false,
  tags: {
    Application: 'zpa-connector',
    ManagedBy: 'cdk',
  },
});

// cdk-nag: every synth and deploy is checked against the AWS Solutions rule pack.
// Accepted findings carry an inline NagSuppressions reason next to the resource,
// and a CSV report is written to cdk.out/. A new unsuppressed error fails the synth.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true, reports: true }));

app.synth();
