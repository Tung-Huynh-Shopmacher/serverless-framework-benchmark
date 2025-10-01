import serverlessExpress from "@vendia/serverless-express";
import { createNestServer } from "./src/main.js";

let cached: any;
export const handler = async (event: any, context: any) => {
  if (!cached) {
    const expressApp = await createNestServer();
    cached = serverlessExpress({ app: expressApp });
  }
  return cached(event, context);
};
