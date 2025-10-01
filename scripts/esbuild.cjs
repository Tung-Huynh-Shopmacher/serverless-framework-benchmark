const esbuild = require("esbuild");

const targets = [
  { entry: "apps/fastify/handler.ts", outdir: "apps/fastify" },
  { entry: "apps/express/handler.ts", outdir: "apps/express" },
  { entry: "apps/nest/handler.ts", outdir: "apps/nest" },
];

// Externalize optional Nest deps so esbuild doesn’t try to resolve them
const external = [
  "class-validator",
  "class-transformer",
  "@nestjs/microservices",
  "@nestjs/microservices/microservices-module",
  "@nestjs/websockets",
  "@nestjs/websockets/socket-module",
];

Promise.all(
  targets.map((t) =>
    esbuild.build({
      entryPoints: [t.entry],
      outfile: `${t.outdir}/index.cjs`,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs", // Lambda-friendly
      minify: true,
      sourcemap: false,
      external,
    })
  )
)
  .then(() => console.log("Built all apps"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
