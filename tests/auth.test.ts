import { describe, it, expect, afterEach, vi } from "vitest";
import type { Request, Response } from "express";
import { requireApiKey } from "../server/auth.js";

function mockReqRes(headers: Record<string, string> = {}) {
  const req = { headers } as unknown as Request;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return { req, res: res as unknown as Response & typeof res };
}

afterEach(() => {
  delete process.env.PIXELDECK_KEY;
});

describe("requireApiKey", () => {
  it("deja pasar cuando PIXELDECK_KEY no está definida", () => {
    const { req, res } = mockReqRes();
    const next = vi.fn();
    requireApiKey(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rechaza sin clave cuando PIXELDECK_KEY está definida", () => {
    process.env.PIXELDECK_KEY = "s3cr3t";
    const { req, res } = mockReqRes();
    const next = vi.fn();
    requireApiKey(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("acepta la clave por X-PixelDeck-Key", () => {
    process.env.PIXELDECK_KEY = "s3cr3t";
    const { req, res } = mockReqRes({ "x-pixeldeck-key": "s3cr3t" });
    const next = vi.fn();
    requireApiKey(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("acepta la clave por Authorization: Bearer", () => {
    process.env.PIXELDECK_KEY = "s3cr3t";
    const { req, res } = mockReqRes({ authorization: "Bearer s3cr3t" });
    const next = vi.fn();
    requireApiKey(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rechaza una clave incorrecta (y de distinta longitud)", () => {
    process.env.PIXELDECK_KEY = "s3cr3t";
    for (const bad of ["nope", "s3cr3", "s3cr3t "]) {
      const { req, res } = mockReqRes({ "x-pixeldeck-key": bad });
      const next = vi.fn();
      requireApiKey(req, res, next);
      expect(next, bad).not.toHaveBeenCalled();
      expect(res.statusCode, bad).toBe(401);
    }
  });
});
