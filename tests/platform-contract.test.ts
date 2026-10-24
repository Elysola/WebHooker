import { describe, test, expect } from "bun:test";
import { renderNeutralMessage as renderDiscord } from "../server/lib/drivers/discord/render";
import { renderNeutralMessage as renderTelegram } from "../server/lib/drivers/telegram/render";
import {
  MAX_TITLE,
  MAX_DESCRIPTION,
  MAX_FIELDS,
  MAX_FIELD_VALUE,
  MAX_FOOTER,
} from "../server/lib/formatters/helpers";
import type { NeutralMessage } from "../server/lib/types";

const big = "x".repeat(10000);

function oversized(): NeutralMessage {
  return {
    title: `acme/widget#1: ${big}`,
    url: "https://github.com/acme/widget",
    description: big,
    fields: Array.from({ length: 30 }, (_, i) => ({ name: `field-${i}`, value: big })),
    footer: big,
  };
}

describe("platform contract", () => {
  test("discord render clamps all limits", () => {
    const embed = renderDiscord(oversized()).embeds?.[0];
    expect(embed).toBeDefined();
    expect(embed!.title!.length).toBeLessThanOrEqual(MAX_TITLE);
    expect(embed!.description!.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(embed!.fields!.length).toBeLessThanOrEqual(MAX_FIELDS);
    for (const f of embed!.fields!) {
      expect(f.value.length).toBeLessThanOrEqual(MAX_FIELD_VALUE);
    }
    expect(embed!.footer).toBeDefined();
    expect(embed!.footer!.text.length).toBeLessThanOrEqual(MAX_FOOTER);
    // Discord also caps the embed's combined text at 6000 characters.
    const total =
      embed!.title!.length +
      embed!.description!.length +
      embed!.footer!.text.length +
      embed!.fields!.reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
  });

  test("discord render never lets content mention anyone but the route's roles", () => {
    const out = renderDiscord({ title: "t", mentionRoleIds: ["123456789012345678"] });
    expect(out.allowed_mentions).toEqual({ parse: [], roles: ["123456789012345678"] });
  });

  test("discord render drops buttons whose id exceeds Discord's limit", () => {
    const out = renderDiscord({
      title: "t",
      actions: [
        { id: `ghpr|merge|o|${"r".repeat(120)}|1`, label: "Merge", style: "primary" },
        { id: "ghpr|close|o|r|1", label: "Close", style: "danger" },
      ],
    });
    expect(out.components![0]!.components.map((c) => c.custom_id)).toEqual(["ghpr|close|o|r|1"]);
  });

  test("telegram render stays within the 4096-char cap", () => {
    const html = renderTelegram(oversized());
    expect(html.length).toBeGreaterThan(4000);
    expect(html.length).toBeLessThan(4200);
  });
});
