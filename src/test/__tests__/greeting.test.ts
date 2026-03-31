import { describe, it, expect } from "bun:test";
import { greet } from "../greeting";

describe("greet", () => {
  it("returns 'Hello, {name}!' for a given name", () => {
    expect(greet("Alice")).toBe("Hello, Alice!");
    expect(greet("Bob")).toBe("Hello, Bob!");
  });

  it("returns 'Hello, World!' for empty string", () => {
    expect(greet("")).toBe("Hello, World!");
  });

  it("returns 'Hello, World!' for whitespace-only string", () => {
    expect(greet("   ")).toBe("Hello, World!");
  });
});
