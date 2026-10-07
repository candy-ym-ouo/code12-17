import crypto from "node:crypto";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { ApiError, asyncHandler } from "./lib/http";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { storage, type StorageVariant } from "./lib/storage";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { globalLimiter } from "./middleware/rateLimit";
import { authRouter } from "./modules/auth/router";
import { exportRouter } from "./modules/export/router";
import { observationRouter } from "./modules/observations/router";
import { observationPhotoRouter, photoRouter } from "./modules/photos/router";
import { shareRouter } from "./modules/share/router";
import { shareLinkRouter, siteRouter } from "./modules/sites/router";
import { phenophaseRouter, speciesRouter } from "./modules/species/router";
import { statsRouter } from "./modules/stats/router";
import { tagRouter } from "./modules/tags/router";
import { qualityRouter } from "./modules/quality/router";

const VARIANTS: StorageVariant[] = ["thumb", "display", "original"];

export function createApp() {
  const app = express();

  if (env.isProd) app.set("trust proxy", 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin: env.APP_ORIGIN.split(",").map((origin) => origin.trim()),
      credentials: true,
    }),
  );
  app.use(
    pinoHttp({
      logger,
      genReqId: () => crypto.randomUUID(),
      customProps: (req) => ({ traceId: req.id }),
    }),
  );
  app.use((req, res, next) => {
    req.traceId = String(req.id ?? "");
    res.setHeader("X-Trace-Id", req.traceId);
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(globalLimiter);

  app.get(
    "/api/v1/healthz",
    asyncHandler(async (_req, res) => {
      res.json({ data: { status: "ok", uptime: process.uptime() } });
    }),
  );

  app.get(
    "/api/v1/readyz",
    asyncHandler(async (_req, res) => {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ data: { status: "ready" } });
    }),
  );

  app.get(
    "/files/:variant/*",
    asyncHandler(async (req, res) => {
      const variant = req.params.variant as StorageVariant;
      if (!VARIANTS.includes(variant)) throw new ApiError(404, "NOT_FOUND", "图片不存在");
      const key = String(req.params[0] ?? "");
      try {
        const buffer = await storage.read(key, variant);
        res.setHeader("Content-Type", "image/webp");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.send(buffer);
      } catch {
        throw new ApiError(404, "NOT_FOUND", "图片不存在");
      }
    }),
  );

  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/sites", siteRouter);
  app.use("/api/v1/share-links", shareLinkRouter);
  app.use("/api/v1/species", speciesRouter);
  app.use("/api/v1/phenophases", phenophaseRouter);
  app.use("/api/v1/tags", tagRouter);

  app.use("/api/v1/observations", observationPhotoRouter);
  app.use("/api/v1/observations", observationRouter);
  app.use("/api/v1/photos", photoRouter);

  app.use("/api/v1/stats", statsRouter);
  app.use("/api/v1/quality", qualityRouter);
  app.use("/api/v1/export", exportRouter);
  app.use("/api/v1/share", shareRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
