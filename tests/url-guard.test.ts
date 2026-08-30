import { describe, it, expect } from "vitest";
import { isPrivateAddress, isBlockedRequestUrl, assertPublicUrl, BlockedUrlError } from "../server/url-guard.js";

describe("isPrivateAddress", () => {
  it("marca los rangos privados / especiales de IPv4", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("deja pasar IPv4 pública", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("marca loopback / link-local / ULA de IPv6", () => {
    for (const ip of ["::1", "fe80::1", "fd00::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("isBlockedRequestUrl", () => {
  it("bloquea esquemas no http, localhost e IPs literales privadas", () => {
    expect(isBlockedRequestUrl("file:///etc/passwd")).toBe(true);
    expect(isBlockedRequestUrl("http://localhost:3000")).toBe(true);
    expect(isBlockedRequestUrl("http://127.0.0.1/")).toBe(true);
    expect(isBlockedRequestUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
    expect(isBlockedRequestUrl("http://[::1]/")).toBe(true);
  });

  it("deja pasar http/https a hosts normales", () => {
    expect(isBlockedRequestUrl("https://example.com/deck")).toBe(false);
    expect(isBlockedRequestUrl("http://93.184.216.34/")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("rechaza esquema no http/https", async () => {
    await expect(assertPublicUrl("ftp://example.com")).rejects.toBeInstanceOf(BlockedUrlError);
  });
  it("rechaza IP literal privada sin tocar DNS", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/")).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertPublicUrl("https://10.1.2.3/x")).rejects.toBeInstanceOf(BlockedUrlError);
  });
  it("rechaza localhost y *.localhost", async () => {
    await expect(assertPublicUrl("http://localhost:8080")).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertPublicUrl("http://foo.localhost/")).rejects.toBeInstanceOf(BlockedUrlError);
  });
  it("rechaza un host que no resuelve", async () => {
    await expect(assertPublicUrl("http://no-existe.invalid/")).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
