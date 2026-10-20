import { describe, expect, it } from "vitest";
import { canonicalize, sha256Hex, contentId } from "../src/core/canonical.js";

describe("canonical JSON", () => {
  it("乱序键输入得到同一哈希（契约）", () => {
    const a = { b: 1, a: { d: [3, 2], c: "x" } };
    const b = { a: { c: "x", d: [3, 2] }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(sha256Hex(canonicalize(a))).toBe(sha256Hex(canonicalize(b)));
  });

  it("输出无冗余空白且键按码点排序", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("undefined 字段被丢弃（与缺省等价）", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it("数组保持顺序（顺序敏感）", () => {
    expect(canonicalize([2, 1])).not.toBe(canonicalize([1, 2]));
  });

  it("contentId 以前缀 + 16 hex 派生，同输入同 ID", () => {
    const p1 = contentId("snap", { x: 1 }, "fp");
    const p2 = contentId("snap", { x: 1 }, "fp");
    expect(p1).toBe(p2);
    expect(p1).toMatch(/^snap_[0-9a-f]{16}$/);
    expect(contentId("snap", { x: 2 }, "fp")).not.toBe(p1);
  });

  it("sha256Hex 对已知输入产生独立可复算摘要", () => {
    // 独立真值：echo -n 'abc' | shasum -a 256
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
