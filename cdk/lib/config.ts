import * as cdk from 'aws-cdk-lib';

/**
 * Strongly-typed configuration for a single ZPA connector fleet.
 * Sourced from cdk.json context under the "zpa" key, overridable with
 *   cdk deploy -c zpa:<key>=<value>
 */
export interface ZpaConfig {
  /** Target AWS account ID (required). */
  account: string;
  /** Target AWS region, e.g. us-east-1 (required). */
  region: string;
  /** Existing VPC ID to deploy the connectors into (required). */
  vpcId: string;
  /** Exactly two private subnet IDs, each in a different AZ (required). */
  privateSubnetIds: string[];

  /** ASG minimum size. Default 2 (HA floor: one per AZ). */
  minCapacity: number;
  /** ASG maximum size. Default 4. */
  maxCapacity: number;
  /** ASG desired size. Default 4. */
  desiredCapacity: number;

  /** EC2 instance type. Default m5a.large (Zscaler production recommendation). */
  instanceType: string;
  /** Root gp3 volume size in GiB. Default 80. */
  volumeSizeGiB: number;

  /** Secrets Manager secret name holding the provisioning key. Default zpa-connector. */
  secretName: string;
  /**
   * Encryption key for the provisioning-key secret, the connector log group,
   * the alarm SNS topic AND the AMI-updater dead-letter queue.
   *   'customer-managed' - DEFAULT. One dedicated KMS CMK (with annual rotation) encrypting the secret,
   *                        the /zpa/connector logs, the SNS topic and the DLQ (~$1/mo/key). Clears the
   *                        CKV_AWS_149 / SECRETSMANAGER_USING_CMK / CLOUDWATCH_LOG_GROUP_ENCRYPTED findings.
   *   'aws-managed'      - Opt-out to AWS-owned/managed keys (aws/secretsmanager + AWS-owned CloudWatch Logs
   *                        key + aws/sns + SQS-managed); no extra cost, but the CMK security findings reappear
   *                        as accepted exceptions. Choose this only where a dedicated CMK is not wanted.
   */
  encryptionKeyType: 'aws-managed' | 'customer-managed';
  /** SSM PatchGroup tag value binding connectors to the sequential patch path. */
  patchGroup: string;
  /** Zscaler ZPA App Connector Marketplace product code. */
  zpaProductCode: string;

  /** Provision the weekly AMI-updater Lambda + EventBridge rule. Default true. */
  enableAmiUpdater: boolean;
  /** Provision a standalone weekly sequential SSM Maintenance Window. Default true. */
  enablePatching: boolean;
  /** Provision CloudWatch alarms + SNS. Default true. */
  enableAlarms: boolean;
  /** Email subscribed to the alarm SNS topic. Required when enableAlarms is true. */
  alarmEmail: string;

  /** Cron for the patch Maintenance Window. Default Sunday 02:00 UTC. */
  patchWindowCron: string;
  /** Cron for the AMI-updater check. Default Sunday 00:00 UTC. */
  amiUpdaterCron: string;
}

function asBool(v: unknown, dflt: boolean): boolean {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'true';
}

function asNum(v: unknown, dflt: number): number {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function asStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.length > 0) return v.split(',').map((s) => s.trim());
  return [];
}

/** Merge cdk.json "zpa" block with any -c zpa:<key> overrides, validate, and return a typed config. */
export function loadZpaConfig(app: cdk.App): ZpaConfig {
  const base = (app.node.tryGetContext('zpa') ?? {}) as Record<string, unknown>;

  // Allow per-key overrides via -c zpa:key=value (flat context keys win over the block).
  const flat = (k: string): unknown => app.node.tryGetContext(`zpa:${k}`);
  const pick = (k: string): unknown => (flat(k) !== undefined ? flat(k) : base[k]);

  const cfg: ZpaConfig = {
    account: String(pick('account') ?? ''),
    region: String(pick('region') ?? ''),
    vpcId: String(pick('vpcId') ?? ''),
    privateSubnetIds: asStrArray(pick('privateSubnetIds')),
    minCapacity: asNum(pick('minCapacity'), 2),
    maxCapacity: asNum(pick('maxCapacity'), 4),
    desiredCapacity: asNum(pick('desiredCapacity'), 4),
    instanceType: String(pick('instanceType') ?? 'm5a.large'),
    volumeSizeGiB: asNum(pick('volumeSizeGiB'), 80),
    secretName: String(pick('secretName') ?? 'zpa-connector'),
    encryptionKeyType: (String(pick('encryptionKeyType') ?? 'customer-managed').toLowerCase() === 'aws-managed'
      ? 'aws-managed'
      : 'customer-managed') as 'aws-managed' | 'customer-managed',
    patchGroup: String(pick('patchGroup') ?? 'zpa-sequential'),
    zpaProductCode: String(pick('zpaProductCode') ?? 'by1wc5269g0048ix2nqvr0362'),
    enableAmiUpdater: asBool(pick('enableAmiUpdater'), true),
    enablePatching: asBool(pick('enablePatching'), true),
    enableAlarms: asBool(pick('enableAlarms'), true),
    alarmEmail: String(pick('alarmEmail') ?? ''),
    patchWindowCron: String(pick('patchWindowCron') ?? 'cron(0 2 ? * SUN *)'),
    amiUpdaterCron: String(pick('amiUpdaterCron') ?? 'cron(0 0 ? * SUN *)'),
  };

  // ---- Validation: fail fast with a clear message ----
  const errs: string[] = [];
  if (!cfg.account) errs.push('zpa:account is required (target AWS account ID)');
  if (!cfg.region) errs.push('zpa:region is required (e.g. us-east-1)');
  if (!cfg.vpcId) errs.push('zpa:vpcId is required (existing VPC to deploy into)');
  if (cfg.privateSubnetIds.length !== 2) {
    errs.push(`zpa:privateSubnetIds must list exactly 2 private subnets in 2 AZs (got ${cfg.privateSubnetIds.length})`);
  }
  if (cfg.minCapacity < 2) errs.push('zpa:minCapacity must be >= 2 for HA across 2 AZs');
  if (cfg.maxCapacity < cfg.minCapacity) errs.push('zpa:maxCapacity must be >= minCapacity');
  if (cfg.desiredCapacity < cfg.minCapacity || cfg.desiredCapacity > cfg.maxCapacity) {
    errs.push('zpa:desiredCapacity must be between minCapacity and maxCapacity');
  }
  if (cfg.enableAlarms && !cfg.alarmEmail) {
    errs.push('zpa:alarmEmail is required when enableAlarms is true (or set enableAlarms=false)');
  }
  const rawKeyType = pick('encryptionKeyType');
  if (rawKeyType !== undefined && rawKeyType !== null && rawKeyType !== '') {
    const v = String(rawKeyType).toLowerCase();
    if (v !== 'aws-managed' && v !== 'customer-managed') {
      errs.push(`zpa:encryptionKeyType must be 'aws-managed' or 'customer-managed' (got '${rawKeyType}')`);
    }
  }
  if (errs.length) {
    throw new Error(`Invalid ZPA config:\n  - ${errs.join('\n  - ')}`);
  }
  return cfg;
}
