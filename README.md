# Lambda Bench (Fastify vs Nest vs Express)

## Prereqs

- Node 20+
- AWS CLI configured with deploy permissions (Lambda, CloudWatch Logs, IAM role creation)
- CDK bootstrapped in your account

## One-time

cp .env.example .env
npm run setup
npm run cdk:bootstrap

## Build + Deploy + Auto-Benchmark

npm run bench

Outputs:

- reports/benchmark-<timestamp>.md
- reports/benchmark-<timestamp>.json

## Clean up

npm run cdk:destroy
