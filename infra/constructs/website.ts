import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

/**
 * The React website: a private S3 bucket (code only, never patient data) behind CloudFront (HTTPS).
 * No domain yet: the address is the free https://<id>.cloudfront.net.
 */
export class Website extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const region = Stack.of(this).region;

    this.bucket = new s3.Bucket(this, 'Bucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            `img-src 'self' data: blob: https://*.s3.${region}.amazonaws.com`,
            `connect-src 'self' https://*.execute-api.${region}.amazonaws.com https://cognito-idp.${region}.amazonaws.com https://*.s3.${region}.amazonaws.com`,
            "frame-ancestors 'none'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join('; '),
          override: true,
        },
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'EHR website',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200, // includes India edge locations
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      // Single-page app: unknown paths load index.html and React Router shows the page.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
    });
  }

  get url(): string {
    return `https://${this.distribution.distributionDomainName}`;
  }

  /**
   * Writes config.json (API URL, Cognito IDs). The rest of the site is uploaded by the frontend repo's CI,
   * which never touches config.json, so the same build works in every stage.
   */
  writeConfig(runtimeConfig: Record<string, string>): void {
    new s3deploy.BucketDeployment(this, 'Config', {
      destinationBucket: this.bucket,
      sources: [s3deploy.Source.jsonData('config.json', runtimeConfig)],
      cacheControl: [s3deploy.CacheControl.fromString('no-cache')],
      prune: false,
      distribution: this.distribution,
      distributionPaths: ['/config.json'],
    });
  }
}
