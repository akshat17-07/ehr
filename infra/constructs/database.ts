import { RemovalPolicy } from 'aws-cdk-lib';
import * as dsql from 'aws-cdk-lib/aws-dsql';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Aurora DSQL cluster: serverless SQL, encrypted at rest by default, no instances to run.
 * Deletion protection is on and the cluster is kept even if the stack is deleted.
 */
export class Database extends Construct {
  readonly cluster: dsql.CfnCluster;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.cluster = new dsql.CfnCluster(this, 'Cluster', { deletionProtectionEnabled: true });
    this.cluster.applyRemovalPolicy(RemovalPolicy.RETAIN);
  }

  get endpoint(): string {
    return this.cluster.attrEndpoint;
  }

  // Lets a role connect as a custom database role (ehr_app), never as admin.
  grantConnect(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['dsql:DbConnect'], resources: [this.cluster.attrResourceArn] }),
    );
  }
}
