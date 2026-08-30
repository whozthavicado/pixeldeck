import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { detectSlidesForced, detectSingleRoot, isSourceKind } from "../core-engine/forced-strategy.js";

function doc(html: string): Document {
  return new JSDOM(html, { pretendToBeVisual: true }).window.document;
}

describe("detectSlidesForced", () => {
  it("claude-design: encuentra las N secciones deck-stage con confianza 1", () => {
    const document = doc(`
      <x-dc>
        <section data-label="Portada" data-screen-label="01">A</section>
        <section data-label="Índice" data-screen-label="02">B</section>
        <section data-label="Cierre" data-screen-label="03">C</section>
      </x-dc>
    `);
    const report = detectSlidesForced(document, "claude-design");
    expect(report.slides).toHaveLength(3);
    expect(report.finalConfidence).toBe(1);
    expect(report.winningStrategy).toBe("forced:claude-design");
  });

  it("reveal: matchea .reveal .slides > section", () => {
    const document = doc(`<div class="reveal"><div class="slides"><section>1</section><section>2</section></div></div>`);
    expect(detectSlidesForced(document, "reveal").slides).toHaveLength(2);
  });

  it("marp: matchea las <section> de .marpit", () => {
    const document = doc(`<div class="marpit"><section>1</section><section>2</section><section>3</section></div>`);
    expect(detectSlidesForced(document, "marp").slides).toHaveLength(3);
  });

  it("slidev: matchea .slidev-page", () => {
    const document = doc(`<div class="slidev-page">1</div><div class="slidev-page">2</div>`);
    expect(detectSlidesForced(document, "slidev").slides).toHaveLength(2);
  });

  it("devuelve slides:[] cuando el hint no matchea nada (→ el motor hace fallback)", () => {
    const document = doc(`<main><h1>Un poster suelto</h1></main>`);
    const report = detectSlidesForced(document, "claude-design");
    expect(report.slides).toHaveLength(0);
    expect(report.finalConfidence).toBe(0);
    expect(report.allResults[0].reason).toContain("detección automática");
  });
});

describe("detectSingleRoot", () => {
  it("trata la raíz como una sola slide", () => {
    const document = doc(`<main id="app"><section>Poster</section></main>`);
    const report = detectSingleRoot(document);
    expect(report.slides).toHaveLength(1);
    expect(report.finalConfidence).toBe(1);
  });
});

describe("isSourceKind", () => {
  it("valida contra la lista", () => {
    expect(isSourceKind("reveal")).toBe(true);
    expect(isSourceKind("auto")).toBe(false);
    expect(isSourceKind(undefined)).toBe(false);
  });
});
