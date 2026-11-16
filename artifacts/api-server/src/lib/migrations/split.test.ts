import { describe, expect, it } from "vitest";
import { splitSql } from "./split.js";

describe("splitSql", () => {
  it("divide due istruzioni", () => {
    expect(splitSql("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });
  it("include l'ultima istruzione senza punto e virgola", () => {
    expect(splitSql("SELECT 1;\nSELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });
  it("non divide dentro stringhe e identificatori", () => {
    expect(splitSql("SELECT 'a;b'; SELECT 'it''s; ok'; SELECT \"col;x\";")).toEqual([
      "SELECT 'a;b'",
      "SELECT 'it''s; ok'",
      'SELECT "col;x"',
    ]);
  });
  it("stringhe E: \\' non chiude la stringa, la E di un identificatore non conta", () => {
    expect(splitSql("SELECT E'\\''; DROP TABLE t; --'")).toEqual(["SELECT E'\\''", "DROP TABLE t"]);
    expect(splitSql("SELECT e'a\\\\'; SELECT 2;")).toEqual(["SELECT e'a\\\\'", "SELECT 2"]);
    expect(splitSql("SELECT E'a;b''c\\'d'; SELECT 2;")).toEqual(["SELECT E'a;b''c\\'d'", "SELECT 2"]);
    // ELSE'a\': stringa normale, la barra non fa escape
    expect(splitSql("SELECT CASE WHEN x THEN 'b' ELSE'a\\' END; SELECT 2;")).toEqual([
      "SELECT CASE WHEN x THEN 'b' ELSE'a\\' END",
      "SELECT 2",
    ]);
  });
  it("un blocco DO resta una istruzione", () => {
    const s = "DO $$ BEGIN x; y; END $$;";
    expect(splitSql(`${s} SELECT 1;`)).toEqual(["DO $$ BEGIN x; y; END $$", "SELECT 1"]);
  });
  it("dollar quoting con tag", () => {
    const s = "CREATE FUNCTION f() AS $fn$ a; b; $fn$ LANGUAGE sql";
    expect(splitSql(`${s};`)).toEqual([s]);
  });
  it("ignora i punti e virgola nei commenti", () => {
    expect(splitSql("-- commento; con punto e virgola\nSELECT 1;")).toEqual([
      "-- commento; con punto e virgola\nSELECT 1",
    ]);
    expect(splitSql("/* a; /* b; */ c; */ SELECT 1;")).toEqual(["/* a; /* b; */ c; */ SELECT 1"]);
  });
  it("CRLF e BOM equivalgono a LF", () => {
    expect(splitSql("﻿SELECT 1;\r\nSELECT 2;\r\n")).toEqual(splitSql("SELECT 1;\nSELECT 2;\n"));
  });
  it("solo commenti o vuoto: nessuna istruzione", () => {
    expect(splitSql("-- a\n/* b */\n;\n  ; ")).toEqual([]);
    expect(splitSql("")).toEqual([]);
  });
});
