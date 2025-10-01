import awsLambdaFastify from "@fastify/aws-lambda";
import Fastify from "fastify";

const app = Fastify();
app.get("/health", async () => "ok");
app.get("/items/:id", async (req) => ({
  id: (req.params as any).id,
  ok: true,
}));

export const handler = awsLambdaFastify(app);
