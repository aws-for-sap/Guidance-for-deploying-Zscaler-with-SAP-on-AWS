#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ZpaConnectorStack } from '../lib/zpa-connector-stack';

const app = new cdk.App();

// Placeholder scaffold. Configure env and props when the full implementation lands.
new ZpaConnectorStack(app, 'ZpaConnectorStack', {
  description: 'Zscaler ZPA App Connector fleet (placeholder scaffold)',
});

app.synth();
