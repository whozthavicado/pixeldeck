import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { detectSlides } from "../core-engine/slide-detector.js";
import { dataSlideAttributeStrategy } from "../core-engine/strategies/data-slide-attribute.js";
import { knownFrameworkSignatureStrategy } from "../core-engine/strategies/known-framework-signature.js";
import { fullscreenSectionStrategy } from "../core-engine/strategies/fullscreen-section.js";
import { ariaTabpanelStrategy } from "../core-engine/strategies/aria-tabpanel.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

function loadFixtureDocument(fileName: string): Document {
  const html = readFileSync(join(fixturesDir, fileName), "utf-8");
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  return dom.window.document;
}

describe("detectSlides — orquestador de scoring", () => {
  it("detecta un deck de Reveal.js vía firma de framework conocido", () => {
    const document = loadFixtureDocument("reveal-js-deck.html");
    const report = detectSlides(document);

    expect(report.slides).toHaveLength(3);
    expect(report.winningStrategy).toContain("known-framework-signature");
    expect(report.finalConfidence).toBeGreaterThan(0.9);
  });

  it("detecta secciones 100vh vía la estrategia fullscreen-section (evidencia estática de hoja de estilos)", () => {
    const document = loadFixtureDocument("fullscreen-100vh-sections.html");
    const report = detectSlides(document);

    expect(report.slides).toHaveLength(3);
    expect(report.winningStrategy).toContain("fullscreen-section");
    // jsdom no calcula layout real, así que la evidencia viene del <style>,
    // no de getBoundingClientRect — confianza moderada, no la máxima.
    expect(report.finalConfidence).toBeGreaterThanOrEqual(0.7);
  });

  it("detecta un deck con navegación por clases toggle vía el patrón genérico .deck > .slide", () => {
    const document = loadFixtureDocument("toggle-class-deck.html");
    const report = detectSlides(document);

    expect(report.slides).toHaveLength(4);
    expect(report.winningStrategy).toContain("known-framework-signature");
  });

  it("detecta y ORDENA por data-slide-index aunque el DOM esté desordenado", () => {
    const document = loadFixtureDocument("data-slide-attribute-deck.html");
    const report = detectSlides(document);

    expect(report.slides).toHaveLength(3);
    expect(report.winningStrategy).toContain("data-slide-attribute");

    const headings = report.slides.map((s) => s.element.querySelector("h1")?.textContent);
    expect(headings).toEqual(["Primera diapositiva", "Diapositiva intermedia", "Segunda diapositiva"]);
  });

  it("NO detecta slides en una página normal (sin falsos positivos)", () => {
    const document = loadFixtureDocument("not-a-deck-regular-page.html");
    const report = detectSlides(document);

    expect(report.slides).toHaveLength(0);
    expect(report.winningStrategy).toBeNull();
    expect(report.finalConfidence).toBe(0);
  });

  it("asigna selectores CSS únicos y re-ubicables a cada slide resuelto", () => {
    const document = loadFixtureDocument("reveal-js-deck.html");
    const report = detectSlides(document);

    for (const slide of report.slides) {
      expect(slide.selector.length).toBeGreaterThan(0);
      const found = document.querySelector(slide.selector);
      expect(found).toBe(slide.element);
    }
  });

  it("sube la confianza compuesta cuando dos estrategias independientes coinciden en el mismo conjunto de elementos", () => {
    // Construimos un documento donde el patrón genérico .deck > .slide
    // TAMBIÉN cumple 100vh vía estilo inline, para forzar acuerdo entre
    // known-framework-signature y fullscreen-section sobre el mismo set.
    const dom = new JSDOM(`
      <!DOCTYPE html><html><body>
        <div class="deck">
          <div class="slide" style="height: 100vh;"><h1>A</h1></div>
          <div class="slide" style="height: 100vh;"><h1>B</h1></div>
        </div>
      </body></html>
    `, { pretendToBeVisual: true });

    const combinedReport = detectSlides(dom.window.document);
    const soloFullscreenReport = detectSlides(dom.window.document, [fullscreenSectionStrategy]);
    const soloSignatureReport = detectSlides(dom.window.document, [knownFrameworkSignatureStrategy]);

    expect(combinedReport.finalConfidence).toBeGreaterThan(soloFullscreenReport.finalConfidence);
    expect(combinedReport.finalConfidence).toBeGreaterThan(soloSignatureReport.finalConfidence);
  });
});

describe("estrategias individuales — casos límite", () => {
  it("data-slide-attribute: confianza 0 si no hay ningún atributo data-slide*", () => {
    const document = loadFixtureDocument("not-a-deck-regular-page.html");
    const result = dataSlideAttributeStrategy.detect(document);
    expect(result.confidence).toBe(0);
  });

  it("aria-tabpanel: requiere al menos 2 tabpanel con padre común para activarse", () => {
    const dom = new JSDOM(`
      <!DOCTYPE html><html><body>
        <div class="tabs">
          <div role="tabpanel" aria-label="Slide 1">Uno</div>
          <div role="tabpanel" aria-label="Slide 2">Dos</div>
          <div role="tabpanel" aria-label="Slide 3">Tres</div>
        </div>
      </body></html>
    `);
    const result = ariaTabpanelStrategy.detect(dom.window.document);
    expect(result.slides).toHaveLength(3);
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it("known-framework-signature: no falsea un match con un solo elemento", () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body><section class="reveal"><div class="slides"><section>Solo una</section></div></section></body></html>`);
    const result = knownFrameworkSignatureStrategy.detect(dom.window.document);
    expect(result.confidence).toBe(0);
  });
});
