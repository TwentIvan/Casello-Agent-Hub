import { describe, expect, it } from "vitest";
import { decodeBody, extractText } from "./extract.js";

describe("decodeBody", () => {
  it("usa il charset dell'header", () => {
    expect(decodeBody(Buffer.from([0x63, 0x61, 0x66, 0xe8]), "iso-8859-1", "text")).toBe("cafè");
  });
  it("senza charset legge il meta dell'HTML", () => {
    const body = Buffer.concat([
      Buffer.from('<html><head><meta charset="windows-1252"></head>caf'),
      Buffer.from([0xe8]),
    ]);
    expect(decodeBody(body, null, "html")).toContain("cafè");
  });
  it("un'etichetta sconosciuta ripiega su UTF-8", () => {
    expect(decodeBody(Buffer.from("caffè", "utf8"), "x-boh", "text")).toBe("caffè");
  });
});

describe("extractText html", () => {
  it("legge il titolo", () => {
    const r = extractText("<html><head><title> Herdr &amp; co </title></head><body>x</body></html>", "html");
    expect(r.title).toBe("Herdr & co");
  });
  it("titolo su una riga e tagliato a 200", () => {
    const r = extractText(`<title>a\n b${"c".repeat(300)}</title>`, "html");
    expect(r.title).not.toContain("\n");
    expect(r.title!.length).toBe(200);
  });
  it("struttura a blocchi", () => {
    expect(extractText("<h1>A</h1><p>b</p><ul><li>c</li></ul>", "html").text).toBe("# A\n\nb\n\n- c");
  });
  it("toglie script, stile e simili", () => {
    const html =
      "<p>a</p><script>x()</script><style>p{}</style><noscript>n</noscript><svg><g>s</g></svg><template>t</template><iframe>i</iframe><!-- c --><p>b</p>";
    expect(extractText(html, "html").text).toBe("a\n\nb");
  });
  it("script senza chiusura toglie fino alla fine", () => {
    expect(extractText("<p>a</p><script>x(); <p>b</p>", "html").text).toBe("a");
  });
  it("i link restano come testo", () => {
    expect(extractText('<a href="https://x">link</a>', "html").text).toBe("link");
  });
  it("decodifica le entità", () => {
    expect(extractText("&laquo;&#8364;&#x20AC;&#99999999;&nbsp;", "html").text).toBe("«€€�");
  });
  it("toglie i caratteri di controllo", () => {
    expect(extractText("<p>a\u0001b\tc</p>", "html").text).toBe("ab c");
  });
  it("1,5 MB di script in meno di 1 s", () => {
    const html = `<script>${"var a=1;".repeat(200_000)}</script><p>ok</p>`;
    const t = Date.now();
    expect(extractText(html, "html").text).toBe("ok");
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("extractText json e testo", () => {
  it("reindenta il JSON", () => {
    expect(extractText('{"a":1}', "json").text).toBe('{\n  "a": 1\n}');
  });
  it("JSON non valido: così com'è", () => {
    expect(extractText("{non json", "json").text).toBe("{non json");
  });
  it("testo: righe vuote ridotte a due", () => {
    expect(extractText("a\n\n\n\n\nb", "text").text).toBe("a\n\n\nb");
  });
});

describe("extractText html: robustezza e struttura", () => {
  it.each(["<a ", "<p ", "<li ", "<h1 ", "<script ", "<title "])("1 MiB di %s ripetuto in meno di 1 s", (frag) => {
    const html = frag.repeat(Math.ceil((1024 * 1024) / frag.length));
    const t = Date.now();
    extractText(html, "html");
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it("ul e li separano il testo che segue", () => {
    expect(extractText("<p>a</p>text<ul><li>x</li></ul>after", "html").text).toBe("a\ntext\n\n- x\n\nafter");
  });
  it("</header> non chiude <head>", () => {
    expect(extractText("<head><header>h</header>x</head><p>ok</p>", "html").text).toBe("ok");
  });
});

describe("extractText: tempi lineari e robustezza", () => {
  const fast = (f: () => unknown) => {
    const t = Date.now();
    f();
    expect(Date.now() - t).toBeLessThan(1000);
  };
  it("2 MiB di spazi più una x (testo) in meno di 1 s", () => {
    const input = " ".repeat(2 * 1024 * 1024) + "x";
    fast(() => expect(extractText(input, "text").text).toBe("x"));
  });
  it("2 MiB di NBSP e di tabulazioni più una x (testo)", () => {
    fast(() => expect(extractText("\u00a0".repeat(2 * 1024 * 1024) + "x", "text").text).toBe("x"));
    fast(() => expect(extractText("a" + "\t".repeat(2 * 1024 * 1024) + "x", "text").text).toBe("a\t".slice(0, 1) + "\t".repeat(2 * 1024 * 1024) + "x"));
  });
  it("circa 1 MiB di &nbsp; più una x (html) in meno di 1 s", () => {
    const html = "<p>" + "&nbsp;".repeat(170_000) + "x</p>";
    fast(() => expect(extractText(html, "html").text).toBe("x"));
  });
  it("JSON profondamente annidato resta com'è, senza esplodere", () => {
    const n = 12_000;
    const input = "[".repeat(n) + "]".repeat(n);
    let out = "";
    fast(() => {
      out = extractText(input, "json").text;
    });
    expect(out.length).toBeLessThanOrEqual(4 * input.length);
    expect(out).toBe(input);
  });
  it("JSON largo e profondo (2 MiB) resta com'è, in fretta e senza stringa enorme", () => {
    const input = "[".repeat(199) + "1,".repeat(1_000_000) + "1" + "]".repeat(199);
    let out = "";
    fast(() => {
      out = extractText(input, "json").text;
    });
    expect(out).toBe(input);
  });
  it("JSON normale si reindenta", () => {
    expect(extractText('{"a":[1,2]}', "json").text).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
  });
  it("«İ» prima di un blocco script non sfasa gli indici", () => {
    const html = "<p>İİİİ prima</p><script>var a=1;</script><p>dopo</p>";
    expect(extractText(html, "html").text).toBe("İİİİ prima\n\ndopo");
    expect(extractText("<head><title>İİ t</title></head><style>x{}</style><p>ok</p>", "html")).toMatchObject({ title: "İİ t", text: "ok" });
  });
});

