import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { OMNIFLOW } from "./stack.js";

/**
 * EMULATION ONLY. What a recipient of the demo uploads as their signed form: the official IRS blank the API serves,
 * with the name (and, on a W-8, the country) filled in — one file per person, so each has its own fingerprint.
 */
const FORMS = {
  w9: { file: "fw9.pdf", name: "topmostSubform[0].Page1[0].f1_01[0]", country: null },
  w8ben: { file: "fw8ben.pdf", name: "topmostSubform[0].Page1[0].f_1[0]", country: "topmostSubform[0].Page1[0].f_2[0]" },
  w8bene: { file: "fw8bene.pdf", name: "topmostSubform[0].Page1[0].f1_1[0]", country: "topmostSubform[0].Page1[0].f1_2[0]" },
} as const;

export type DemoForm = keyof typeof FORMS;

export async function signedForm(type: DemoForm, name: string, country?: string): Promise<Buffer> {
  const f = FORMS[type];
  const doc = await PDFDocument.load(readFileSync(resolve(OMNIFLOW, "apps/api/assets/irs", f.file)));
  const form = doc.getForm();
  // filled and locked, not flattened: the W-8 blanks have widgets without appearances, which flattening cannot handle
  for (const [field, value] of [[f.name, name], [f.country, country]] as const) {
    if (!field || !value) continue;
    const t = form.getTextField(field);
    t.setText(value);
    t.enableReadOnly();
  }
  doc.setTitle(`${name} — signed form (demo)`);
  return Buffer.from(await doc.save());
}
