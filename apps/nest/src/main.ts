import { Controller, Get, Module, Param } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import "reflect-metadata";

@Controller()
class AppController {
  @Get("health") health() {
    return "ok";
  }
  @Get("items/:id") item(@Param("id") id: string) {
    return { id, ok: true };
  }
}

@Module({ controllers: [AppController] })
export class AppModule {}

export async function createNestServer() {
  const app = await NestFactory.create(AppModule); // uses @nestjs/platform-express
  await app.init();
  return (app as any).getHttpAdapter().getInstance();
}
