import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Official IRS forms, kept byte for byte as downloaded from irs.gov (public domain, U.S. government works).
 * Checked 2026-10-04: URL, revision printed on the form, SHA-256 of the file.
 * The recipient's forms are handed out exactly as they are; only Form 1099-NEC is filled, and only its Copy B.
 */
export type RecipientForm = "w9" | "w8ben" | "w8bene";

export const RECIPIENT_FORMS: Record<RecipientForm, { label: string; file: string; url: string; revision: string; sha256: string }> = {
  w9: {
    label: "W-9",
    file: "fw9.pdf",
    url: "https://www.irs.gov/pub/irs-pdf/fw9.pdf",
    revision: "March 2024",
    sha256: "2d420cbb4123dcf1fb82595b2359cfbb5d81f00b9df9d359fcc7af361d093f53",
  },
  w8ben: {
    label: "W-8BEN",
    file: "fw8ben.pdf",
    url: "https://www.irs.gov/pub/irs-pdf/fw8ben.pdf",
    revision: "October 2021",
    sha256: "b821dc1172c91b348a65675529cc792782f11fc1ae8579df92d627113203f918",
  },
  w8bene: {
    label: "W-8BEN-E",
    file: "fw8bene.pdf",
    url: "https://www.irs.gov/pub/irs-pdf/fw8bene.pdf",
    revision: "October 2021",
    sha256: "d67fc5abae5af11df5d6168a60f7a7e7f27044efa63f660cb76c0e47a241ef6e",
  },
};

export const isRecipientForm = (v: unknown): v is RecipientForm => typeof v === "string" && v in RECIPIENT_FORMS;

/** What the dashboard shows in the DOCUMENT column: nothing, "requested", or the form that arrived. */
export function documentLabel(required: string, status: string): string {
  if (status === "received") return isRecipientForm(required) ? RECIPIENT_FORMS[required].label : "received";
  return status === "requested" ? "requested" : "";
}

/**
 * Form 1099-NEC, Rev. December 2026 — the revision for amounts paid in calendar year 2026.
 * Page 1 says: "Do not print and file copy A of this PDF … You may download and print Copy B and other copies of this
 * form, which appear in black, to satisfy the requirement to furnish the information to the recipient."
 * So only Copy B (page 4) and its back, "Instructions for Recipient" (page 5), are ever handed out.
 */
export const NEC = {
  file: "f1099nec.pdf",
  url: "https://www.irs.gov/pub/irs-pdf/f1099nec.pdf",
  revision: "December 2026",
  firstYear: 2026,
  sha256: "68a8f00078be6dd6a4912cc4209df317b31840d5fe19560222d39df9f2f7ff49",
  /** zero-based pages kept in the output: Copy B and the recipient instructions */
  recipientPages: [3, 4],
  /**
   * AcroForm fields of Copy B. The form has no tooltips; each field was matched to the box label printed above it
   * on page 4 by position (see the field rectangles in the PDF).
   */
  copyB: {
    calendarYear: "topmostSubform[0].CopyB[0].PgHeader[0].CalendarYear[0].f2_1[0]",
    payerName: "topmostSubform[0].CopyB[0].LeftCol[0].f2_2[0]",
    payerStreet: "topmostSubform[0].CopyB[0].LeftCol[0].f2_3[0]",
    payerRoom: "topmostSubform[0].CopyB[0].LeftCol[0].f2_4[0]",
    payerCity: "topmostSubform[0].CopyB[0].LeftCol[0].f2_5[0]",
    payerPhone: "topmostSubform[0].CopyB[0].LeftCol[0].f2_6[0]",
    payerState: "topmostSubform[0].CopyB[0].LeftCol[0].f2_7[0]",
    payerCountry: "topmostSubform[0].CopyB[0].LeftCol[0].f2_8[0]",
    payerZip: "topmostSubform[0].CopyB[0].LeftCol[0].f2_9[0]",
    payerTin: "topmostSubform[0].CopyB[0].LeftCol[0].f2_10[0]",
    recipientTin: "topmostSubform[0].CopyB[0].LeftCol[0].f2_11[0]",
    recipientName: "topmostSubform[0].CopyB[0].LeftCol[0].f2_12[0]",
    recipientStreet: "topmostSubform[0].CopyB[0].LeftCol[0].f2_13[0]",
    recipientApt: "topmostSubform[0].CopyB[0].LeftCol[0].f2_14[0]",
    recipientCity: "topmostSubform[0].CopyB[0].LeftCol[0].f2_15[0]",
    recipientState: "topmostSubform[0].CopyB[0].LeftCol[0].f2_16[0]",
    recipientCountry: "topmostSubform[0].CopyB[0].LeftCol[0].f2_17[0]",
    recipientZip: "topmostSubform[0].CopyB[0].LeftCol[0].f2_18[0]",
    accountNumber: "topmostSubform[0].CopyB[0].LeftCol[0].f2_19[0]",
    box1NonemployeeCompensation: "topmostSubform[0].CopyB[0].RightCol[0].f2_20[0]",
  },
};

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "irs");
export const irsFile = (file: string) => readFileSync(join(ASSETS, file));
