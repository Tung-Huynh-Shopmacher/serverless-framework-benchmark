import serverlessExpress from "@vendia/serverless-express";
import express from "express";

const app = express();
app.get("/health", (_req, res) => res.send("ok"));
app.get("/items/:id", (req, res) => res.json({ id: req.params.id, ok: true }));

export const handler = serverlessExpress({ app });
