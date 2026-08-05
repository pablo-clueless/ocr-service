import { describe, expect, it } from "vitest";

import { parseMrz } from "../src/functions/id-verification/mrz";

// TD3 specimen based on the canonical ICAO example, but with a real ISO country
// code (NGA) — the `mrz` package validates country codes against a real list, and
// the ICAO example's fictional "UTO" fails that check. Country codes are not part
// of any MRZ check digit, so all checksums remain valid. Line 1 is padded to
// exactly 44 chars so the fixture can't drift on a miscounted filler.
const VALID_TD3 = ["P<NGAERIKSSON<<ANNA<MARIA".padEnd(44, "<"), "L898902C36NGA7408122F1204159ZE184226B<<<<<10"].join(
  "\n",
);

describe("parseMrz", () => {
  it("parses a valid TD3 passport and validates the checksums", () => {
    const result = parseMrz(`Some header text\n\n${VALID_TD3}`);
    expect(result).toBeDefined();
    expect(result!.valid).toBe(true);
    expect(result!.fields.documentNumber).toBe("L898902C3");
    expect(result!.fields.nationality).toBe("NGA");
    expect(result!.fields.sex).toBe("female");
    expect(result!.fields.dateOfBirth).toBe("740812");
    expect(result!.fields.expiryDate).toBe("120415");
    expect(result!.fields.fullName).toContain("ERIKSSON");
  });

  it("reports valid=false when a check digit is tampered", () => {
    // Flip the trailing composite check digit 0 → 1.
    const tampered = VALID_TD3.replace("B<<<<<10", "B<<<<<11");
    const result = parseMrz(tampered);
    expect(result).toBeDefined();
    expect(result!.valid).toBe(false);
  });

  it("returns undefined when no MRZ lines are present", () => {
    expect(parseMrz("Just an ordinary paragraph of text.\nNo machine-readable zone here.")).toBeUndefined();
  });

  it("returns undefined with fewer than two candidate lines", () => {
    expect(parseMrz("P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<")).toBeUndefined();
  });
});
