import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';

export class PersistantEtcFilesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Create a VPC
    const vpc = new ec2.Vpc(this, 'PersistantEtcFilesVpc', {
      maxAzs: 1, // Adjust as needed
    });

    // Create a security group for EC2
    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
    });

    // Allow necessary inbound traffic to EC2
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(2049), 'NFS');
    securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allTraffic(), 'Allow all outbound traffic');
    securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(2049), 'NFS');
    // Add additional inbound rules as needed

    // Create an EFS file system
    const efsFileSystem = new efs.FileSystem(this, 'EfsFileSystem', {
      vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS, // Adjust as needed
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, // Choose the appropriate subnet type
      },
      securityGroup: securityGroup,
    });

    // EC2 user data script
    const userData = ec2.UserData.forLinux({
      shebang: '#!/bin/bash',
    });
    const region = cdk.Aws.REGION; // Dynamically get the current region

    userData.addCommands(
      'yum update -y', // Update the system
      'yum install -y nfs-utils', // Install NFS utilities
      'yum install -y amazon-efs-utils', // Install EFS utilities
      'yum install -y aws-ssm-agent',
      'systemctl start amazon-ssm-agent',
      'systemctl enable amazon-ssm-agent',

      // Install and enable the cron service
      'yum install -y cronie',
      'systemctl enable crond',
      'systemctl start crond',

      'echo "Mounting EFS filesystem..."',
      'mkdir -p /mnt/efs', // Create a mount point

      // Mount the EFS file system
      `echo "${efsFileSystem.fileSystemId}.efs.${region}.amazonaws.com:/ /mnt/efs nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,_netdev 0 0" | tee -a /etc/fstab`,
      'echo sleep 30',
      'sleep 30', // Sleep for 30 seconds to allow the EFS mount point to be created.
      'echo mount -a command...',
      'sudo mount -a',
      'echo sleep 30',
      'sleep 30', // Sleep for 30 seconds to allow the EFS mount point to be created.
      'echo continuing...',


      // Setup NFS exports
      'echo "/mnt/efs *(rw,async,no_root_squash)" >> /etc/exports', // NFS export for EFS
      'exportfs -a',
      'systemctl start nfs-server',
      'systemctl enable nfs-server',

      // Copy necessary files from NFS share to their respective locations
      'mkdir -p /mnt/efs/etc', // Create a directory for the files 
      'echo "Copying /etc files from NFS share..."',
      'cp /mnt/efs/etc/passwd /etc/passwd 2>/dev/null || echo "No /etc/passwd file found on NFS share or copy failed"',
      'cp /mnt/efs/etc/group /etc/group 2>/dev/null || echo "No /etc/group file found on NFS share or copy failed"',
      'cp /mnt/efs/etc/shadow /etc/shadow 2>/dev/null || echo "No /etc/shadow file found on NFS share or copy failed"',
      'echo "Files in /etc copied successfully!"',

      // Backup cron jobs
      'echo "0 * * * * root cp -r /etc/passwd /mnt/efs/etc/passwd" >> /etc/crontab',
      'echo "0 * * * * root cp -r /etc/group /mnt/efs/etc/group" >> /etc/crontab',
      'echo "0 * * * * root cp -r /etc/shadow /mnt/efs/etc/shadow" >> /etc/crontab',

      // Restart the cron service to apply the changes
      'systemctl restart crond',
    );

    // Create an EC2 instance
    const instance = new ec2.Instance(this, 'PersistEtcFilesnstance', {
      vpc,
      // instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO), // Adjust as needed
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3A,
        ec2.InstanceSize.MICRO
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup,
      ssmSessionPermissions: true, // Enable SSM Session Manager
      userData,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, // Use private subnets
    });

    // Set the instance profile for the EC2 instance
    instance.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonElasticFileSystemClientFullAccess')); // Add the necessary policy

    // Create an IAM policy for EFS
    const efsPolicy = new iam.Policy(this, 'EfsPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['elasticfilesystem:ClientMount'],
          resources: [efsFileSystem.fileSystemArn],
        }),
      ]}
    );

    // Attach the policy to the EC2 instance role
    efsPolicy.attachToRole(instance.role);


    // Output the instance's public IP address for SSH access
    // new cdk.CfnOutput(this, 'InstancePublicIp', {
    //   value: instance.instancePublicIp,
    // });
  }
}
