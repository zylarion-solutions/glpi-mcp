import { describe, expect, it } from "vitest";
import { decodeEntities, excerpt, htmlToText, safeHref, stripTags, textifyRecord } from "../src/text.js";

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("R&amp;D &lt;b&gt; &#233;&#x00F1; caf&eacute; &unknown;")).toBe("R&D <b> éñ café &unknown;");
  });
});

describe("stripTags", () => {
  it("never leaves a tag rebuilt from nested pieces", () => {
    expect(stripTags("<scr<script>ipt>alert(1)</script>")).toBe("alert(1)");
    expect(stripTags("<<b>script>x")).toBe("x");
    expect(stripTags("a > b < c")).toBe("a  b  c");
  });
});

describe("htmlToText", () => {
  it("handles GLPI's entity-encoded (sanitized) content", () => {
    expect(htmlToText("&lt;p&gt;La VPN no conecta&lt;/p&gt;&lt;p&gt;Desde ayer&lt;/p&gt;")).toBe("La VPN no conecta\n\nDesde ayer");
  });

  it("keeps structure: line breaks, lists, links, emphasis and images", () => {
    const html =
      '<p>Hello <strong>team</strong>,<br>steps:</p><ul><li>Reboot</li><li>See <a href="https://kb.example/1">KB 1</a></li></ul>' +
      '<p><img src="/front/document.send.php?docid=42" alt="error"></p><script>alert(1)</script>';
    expect(htmlToText(html)).toBe(
      "Hello **team**,\nsteps:\n\n- Reboot\n- See KB 1 (https://kb.example/1)\n\n[image: error (document 42)]",
    );
  });

  it("drops javascript: links and keeps plain text untouched", () => {
    expect(htmlToText('<a href="javascript:alert(1)">click</a>')).toBe("click");
    expect(htmlToText("just text &amp; more")).toBe("just text & more");
    expect(htmlToText(null)).toBe("");
  });
});

describe("safeHref", () => {
  it("keeps web, mail and relative links only", () => {
    expect(safeHref("https://x.co/a")).toBe("https://x.co/a");
    expect(safeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(safeHref("/front/ticket.form.php?id=1")).toBe("/front/ticket.form.php?id=1");
    for (const bad of ["javascript:alert(1)", " JavaScript:x", "data:text/html,x", "vbscript:x", "&#106;avascript:x", "//evil.example"]) {
      expect(safeHref(bad)).toBeUndefined();
    }
  });

  it("removes script blocks rebuilt from nested pieces", () => {
    expect(htmlToText("<p>a</p><scr<script>x</script>ipt>alert(1)</script>b")).toBe("a\n\nb");
  });
});

describe("helpers", () => {
  it("excerpt flattens and cuts", () => {
    expect(excerpt("a\n\nb   c", 10)).toBe("a b c");
    expect(excerpt("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("textifyRecord converts only rich-text fields", () => {
    expect(textifyRecord({ id: 1, name: "<b>n</b>", content: "<p>c</p>", answer: "<i>a</i>" })).toEqual({
      id: 1,
      name: "<b>n</b>",
      content: "c",
      answer: "_a_",
    });
  });
});
