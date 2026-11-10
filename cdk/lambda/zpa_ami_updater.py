"""
ZPA App Connector AMI updater Lambda function

Queries AWS Marketplace for the latest Zscaler ZPA Connector AMI (by product code),
compares it to the AMI in the launch template version the ASG is running, and if newer:
1. Creates a new launch template version from the ASG's version with the updated AMI
2. Sets it as the default version
3. Optionally triggers an ASG instance refresh pinned to the new version

Deployed once for each account and Region that runs a connector fleet.

Environment Variables:
    LAUNCH_TEMPLATE_ID  - Launch template ID (for example, lt-0123456789abcdef0)
    ASG_NAME            - Auto Scaling group name (for example, zpa-connector-asg)
    ZPA_PRODUCT_CODE    - Marketplace product code (default: by1wc5269g0048ix2nqvr0362)
    INSTANCE_REFRESH    - "true" to trigger ASG instance refresh after AMI update (default: "false")
    SNS_TOPIC_ARN       - Optional SNS topic for notifications
"""

import json
import os
import logging
import boto3
from datetime import datetime

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Configuration from environment
LAUNCH_TEMPLATE_ID = os.environ["LAUNCH_TEMPLATE_ID"]
ASG_NAME = os.environ["ASG_NAME"]
ZPA_PRODUCT_CODE = os.environ.get("ZPA_PRODUCT_CODE", "by1wc5269g0048ix2nqvr0362")
INSTANCE_REFRESH = os.environ.get("INSTANCE_REFRESH", "false").lower() == "true"
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")


def verify_ami_integrity(image):
    """Fail closed unless the image is the Zscaler AWS Marketplace AMI.

    Zscaler publishes the AMI through AWS Marketplace, so the image owner is the AWS Marketplace
    account (owner alias aws-marketplace, which only AWS can set). The image must also carry the
    Zscaler Marketplace product code, be available and EBS-backed, and not be past its
    deprecation time. Any failure raises, so no launch template version or refresh is created.
    """
    problems = []
    if image.get("ImageOwnerAlias") != "aws-marketplace":
        problems.append(f"owner alias is {image.get('ImageOwnerAlias')!r}, expected 'aws-marketplace'")
    codes = {(pc.get("ProductCodeId"), pc.get("ProductCodeType")) for pc in image.get("ProductCodes", [])}
    if (ZPA_PRODUCT_CODE, "marketplace") not in codes:
        problems.append(f"product code {ZPA_PRODUCT_CODE} (marketplace) not on the image")
    if image.get("State") != "available":
        problems.append(f"state is {image.get('State')!r}")
    if image.get("RootDeviceType") != "ebs":
        problems.append(f"root device type is {image.get('RootDeviceType')!r}")
    deprecation = image.get("DeprecationTime")
    if deprecation:
        when = datetime.strptime(deprecation.replace("Z", ""), "%Y-%m-%dT%H:%M:%S.%f")
        if when <= datetime.utcnow():
            problems.append(f"image deprecated since {deprecation}")
    if problems:
        raise RuntimeError(f"AMI integrity check failed for {image.get('ImageId')}: " + "; ".join(problems))
    logger.info(f"AMI integrity check passed for {image['ImageId']} (owner alias aws-marketplace, product code {ZPA_PRODUCT_CODE})")


def get_latest_zpa_ami(ec2_client):
    """Query Marketplace for the latest available ZPA connector AMI."""
    # Owners=aws-marketplace matches the CDK LookupMachineImage and ensures only
    # Marketplace-published images (never a private/shared AMI carrying the same
    # product code) can be adopted by the instance refresh.
    response = ec2_client.describe_images(
        Owners=["aws-marketplace"],
        Filters=[
            {"Name": "product-code", "Values": [ZPA_PRODUCT_CODE]},
            {"Name": "state", "Values": ["available"]},
        ]
    )

    images = response.get("Images", [])
    if not images:
        raise RuntimeError(f"No available AMIs found for product code {ZPA_PRODUCT_CODE}")

    # Sort by CreationDate descending, take newest
    images.sort(key=lambda x: x["CreationDate"], reverse=True)
    latest = images[0]
    verify_ami_integrity(latest)

    # Determine the root volume snapshot size from the AMI's block device mappings
    root_volume_size = None
    root_device_name = latest.get("RootDeviceName", "/dev/xvda")
    for bdm in latest.get("BlockDeviceMappings", []):
        if bdm.get("DeviceName") == root_device_name:
            root_volume_size = bdm.get("Ebs", {}).get("VolumeSize")
            break

    return {
        "ImageId": latest["ImageId"],
        "Name": latest["Name"],
        "CreationDate": latest["CreationDate"],
        "DeprecationTime": latest.get("DeprecationTime", "N/A"),
        "RootVolumeSize": root_volume_size,
    }


def get_asg_lt_version(asg_client):
    """Return the launch template version the ASG actually launches with.

    CloudFormation adds a new launch template version on every stack update but
    leaves the template's *default* version unchanged, and pins the ASG to a version
    number. The default version can therefore be an old, superseded version, so the
    ASG's own configured version is the only reliable source to build from.
    Returns the version as a string ("3", "$Latest" or "$Default").
    """
    response = asg_client.describe_auto_scaling_groups(AutoScalingGroupNames=[ASG_NAME])
    groups = response.get("AutoScalingGroups", [])
    if not groups:
        raise RuntimeError(f"Auto Scaling group {ASG_NAME} not found")
    lt = groups[0].get("LaunchTemplate")
    if not lt or lt.get("LaunchTemplateId") != LAUNCH_TEMPLATE_ID:
        raise RuntimeError(
            f"ASG {ASG_NAME} does not use launch template {LAUNCH_TEMPLATE_ID} (found {lt})"
        )
    return str(lt.get("Version", "$Default"))


def get_current_lt_ami(ec2_client, asg_version):
    """Get the AMI ID from the launch template version the ASG is using."""
    response = ec2_client.describe_launch_template_versions(
        LaunchTemplateId=LAUNCH_TEMPLATE_ID,
        Versions=[asg_version],
    )

    versions = response.get("LaunchTemplateVersions", [])
    if not versions:
        raise RuntimeError(f"Version {asg_version} not found for launch template {LAUNCH_TEMPLATE_ID}")

    lt_data = versions[0]["LaunchTemplateData"]
    return {
        "ImageId": lt_data.get("ImageId"),
        "VersionNumber": versions[0]["VersionNumber"],
        "VersionDescription": versions[0].get("VersionDescription", ""),
    }


def update_launch_template(ec2_client, source_version, new_ami_id, new_ami_name, required_volume_size):
    """Create a new launch template version with the updated AMI and set as default.

    The new version is built from source_version (the version the ASG runs), so
    user data, encryption and every other setting carry over unchanged.
    Also ensures the root EBS volume size is at least as large as the AMI's
    snapshot size to prevent launch failures.
    """
    # Create new version sourced from the version the ASG is running
    description = f"Auto-update: {new_ami_name} ({datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')})"

    # Build LaunchTemplateData with AMI and volume size adjustment
    lt_data = {"ImageId": new_ami_id}

    if required_volume_size:
        # Get the current launch template's volume configuration
        current_lt = ec2_client.describe_launch_template_versions(
            LaunchTemplateId=LAUNCH_TEMPLATE_ID,
            Versions=[source_version],
        )
        current_bdm = current_lt["LaunchTemplateVersions"][0]["LaunchTemplateData"].get(
            "BlockDeviceMappings", []
        )

        # Check if the current volume size is smaller than what the new AMI requires
        needs_volume_update = False
        for bdm in current_bdm:
            ebs = bdm.get("Ebs", {})
            current_size = ebs.get("VolumeSize", 0)
            if current_size < required_volume_size:
                needs_volume_update = True
                break

        if needs_volume_update:
            # Update BlockDeviceMappings with the required volume size, preserving other EBS settings
            updated_bdm = []
            for bdm in current_bdm:
                new_bdm = dict(bdm)
                if "Ebs" in new_bdm:
                    new_ebs = dict(new_bdm["Ebs"])
                    if new_ebs.get("VolumeSize", 0) < required_volume_size:
                        logger.info(
                            f"Increasing volume size from {new_ebs.get('VolumeSize')}GB "
                            f"to {required_volume_size}GB to match AMI snapshot"
                        )
                        new_ebs["VolumeSize"] = required_volume_size
                    # Remove SnapshotId if present — the new AMI's snapshot will be used automatically
                    new_ebs.pop("SnapshotId", None)
                    new_bdm["Ebs"] = new_ebs
                updated_bdm.append(new_bdm)

            lt_data["BlockDeviceMappings"] = updated_bdm

    response = ec2_client.create_launch_template_version(
        LaunchTemplateId=LAUNCH_TEMPLATE_ID,
        SourceVersion=source_version,
        LaunchTemplateData=lt_data,
        VersionDescription=description,
    )

    new_version = response["LaunchTemplateVersion"]["VersionNumber"]
    logger.info(f"Created launch template version {new_version}: {description}")

    # Set as default
    ec2_client.modify_launch_template(
        LaunchTemplateId=LAUNCH_TEMPLATE_ID,
        DefaultVersion=str(new_version),
    )
    logger.info(f"Set version {new_version} as default")

    return new_version


def trigger_instance_refresh(asg_client, new_version):
    """Trigger a rolling instance refresh onto the new launch template version.

    The ASG is pinned to a launch template version number, so a refresh without a
    DesiredConfiguration would relaunch the SAME version and never adopt the new
    AMI. Passing the new version makes Auto Scaling replace instances with it and,
    once the refresh succeeds, update the ASG to that version.
    """
    response = asg_client.start_instance_refresh(
        AutoScalingGroupName=ASG_NAME,
        Strategy="Rolling",
        DesiredConfiguration={
            "LaunchTemplate": {
                "LaunchTemplateId": LAUNCH_TEMPLATE_ID,
                "Version": str(new_version),
            }
        },
        Preferences={
            "MinHealthyPercentage": 75,
            "InstanceWarmup": 300,
            "MaxHealthyPercentage": 125,
        },
    )
    refresh_id = response["InstanceRefreshId"]
    logger.info(f"Triggered instance refresh: {refresh_id}")
    return refresh_id


def send_notification(sns_client, subject, message):
    """Send SNS notification if topic is configured."""
    if not SNS_TOPIC_ARN:
        return
    try:
        sns_client.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject=subject[:100],
            Message=message,
        )
    except Exception as e:
        logger.warning(f"Failed to send SNS notification: {e}")


def lambda_handler(event, context):
    """Main handler."""
    region = os.environ.get("AWS_REGION", "us-west-2")
    logger.info(f"ZPA AMI Updater running in {region}")
    logger.info(f"Launch Template: {LAUNCH_TEMPLATE_ID}, ASG: {ASG_NAME}")

    ec2 = boto3.client("ec2", region_name=region)
    asg = boto3.client("autoscaling", region_name=region)
    sns = boto3.client("sns", region_name=region)

    # Step 1: Get latest available ZPA AMI from Marketplace
    latest_ami = get_latest_zpa_ami(ec2)
    logger.info(f"Latest ZPA AMI: {latest_ami['ImageId']} ({latest_ami['Name']}, created {latest_ami['CreationDate']}, root vol: {latest_ami['RootVolumeSize']}GB)")

    # Step 2: Get current AMI from the launch template version the ASG is running
    asg_version = get_asg_lt_version(asg)
    current_lt = get_current_lt_ami(ec2, asg_version)
    logger.info(f"Current LT AMI: {current_lt['ImageId']} (ASG version {asg_version}, resolved to {current_lt['VersionNumber']})")

    # Step 3: Compare
    if latest_ami["ImageId"] == current_lt["ImageId"]:
        logger.info("AMI is already up to date. No action needed.")
        return {
            "statusCode": 200,
            "action": "none",
            "currentAmi": current_lt["ImageId"],
            "latestAmi": latest_ami["ImageId"],
            "message": "Already up to date",
        }

    # Step 4: Update launch template (with volume size adjustment if needed)
    logger.info(f"AMI update available: {current_lt['ImageId']} -> {latest_ami['ImageId']}")
    new_version = update_launch_template(
        ec2, str(current_lt["VersionNumber"]), latest_ami["ImageId"], latest_ami["Name"], latest_ami["RootVolumeSize"]
    )

    # Step 5: Optionally trigger instance refresh onto the new version
    refresh_id = None
    if INSTANCE_REFRESH:
        refresh_id = trigger_instance_refresh(asg, new_version)

    # Step 6: Send notification
    message = (
        f"ZPA AMI Updated in {region}\n"
        f"Account: {context.invoked_function_arn.split(':')[4]}\n"
        f"Launch Template: {LAUNCH_TEMPLATE_ID}\n"
        f"ASG: {ASG_NAME}\n\n"
        f"Previous AMI: {current_lt['ImageId']} (LT version {current_lt['VersionNumber']})\n"
        f"New AMI: {latest_ami['ImageId']} ({latest_ami['Name']})\n"
        f"New AMI Root Volume: {latest_ami['RootVolumeSize']}GB\n"
        f"New LT Version: {new_version}\n"
        f"Instance Refresh: {refresh_id or 'Disabled'}\n\n"
        f"New instances launched by the ASG will now use the updated AMI.\n"
        f"Existing instances remain on the old AMI until replaced."
    )
    send_notification(sns, f"[ZPA] App Connector AMI updated in {region}", message)

    result = {
        "statusCode": 200,
        "action": "updated",
        "previousAmi": current_lt["ImageId"],
        "newAmi": latest_ami["ImageId"],
        "newAmiName": latest_ami["Name"],
        "newAmiRootVolumeSize": latest_ami["RootVolumeSize"],
        "newLtVersion": new_version,
        "instanceRefresh": refresh_id,
        "region": region,
    }
    logger.info(f"Result: {json.dumps(result)}")
    return result
