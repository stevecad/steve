/**
 * McMaster-Carr, the way vibecad's McMasterInsert does it: the person browses www.mcmaster.com in its own window
 * (the site refuses frames and has no open API), downloads a part's 3-D STEP, and drops the file here. Nothing in
 * STEVE contacts mcmaster.com. Part-number parsing follows vibecad (PART_NUMBER_RE / FILENAME_PN_RE); the server
 * (app/vendor_parts.py) applies the same rules and is the source of truth.
 */
import { create } from 'zustand';
import { set } from './store';
import { mcmasterUrl } from '@/lib/safeUrl';

export const CATALOG_URL = 'https://www.mcmaster.com/';
const PART_NUMBER = /^[0-9]{2,6}[A-Za-z][0-9A-Za-z]{1,8}$/;
const FILENAME_PART_NUMBER = /([0-9]{2,6}[A-Za-z][0-9A-Za-z]{1,8})/;
/** A McMaster download: the part number leads the name, after an optional CAD-variant prefix ("3-D STEP …"). */
const MCMASTER_NAME = /^(?:(?:3-?D\s*STEP|3D|STEP|NO[\s-]?THREADS|SIMPLIFIED)[\s_-]*)?([0-9]{2,6}[A-Za-z][0-9A-Za-z]{1,8})(?:[\s_.-]|$)/i;
const VARIANT = /^(3-?D\s*STEP|3D|STEP|NO THREADS|NO-THREADS|NOTHREADS|SIMPLIFIED)\s+/i;
export const MCMASTER_SUFFIXES = /\.(step|stp|zip)$/i;

const stem = (name: string) => name.replace(/\.[^.]+$/, '');

/** A part number as McMaster writes it, from a number, a pasted product URL or spaced text. */
export function normalizePartNumber(raw: string): string {
  let token = (raw ?? '').trim();
  if (/mcmaster\.com/i.test(token)) token = token.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() ?? '';
  return token.trim().toUpperCase().replace(/\s+/g, '').replace(/^\/+|\/+$/g, '');
}

export const isPartNumber = (value: string) => PART_NUMBER.test(value);
export const productUrl = (partNumber: string) => `https://www.mcmaster.com/${partNumber}`;

export function partNumberFromFilename(name: string): string {
  const match = FILENAME_PART_NUMBER.exec(stem(name).toUpperCase().replace(/\s+/g, ''));
  return match && PART_NUMBER.test(match[1]) ? match[1] : '';
}

/** The catalog title from a McMaster file name, without the part number or CAD-variant prefixes. */
export function catalogDescription(partNumber: string, name: string): string {
  let title = stem(name).replace(/[_\s]+/g, ' ').trim().replace(VARIANT, '').trim();
  if (partNumber) title = title.replace(new RegExp(`^${partNumber}[\\s-]*`, 'i'), '').replace(/^[\s-]+|[\s-]+$/g, '');
  title = title.replace(VARIANT, '').replace(/\s+/g, ' ').trim();
  return !title || title.toUpperCase() === partNumber.toUpperCase() ? 'McMaster-Carr catalog part' : title.slice(0, 120);
}

/** Whether a dropped file looks like a McMaster download (its name leads with a part number), or is a ZIP. */
export const isMcmasterFile = (file: File) => MCMASTER_SUFFIXES.test(file.name) && (/\.zip$/i.test(file.name) || MCMASTER_NAME.test(stem(file.name)));

/** A file handed to the McMaster dialog (dropped on the viewport, or chosen in the dialog). */
export const useMcmaster = create<{ file: File | null }>(() => ({ file: null }));

export function receiveMcmasterFile(file: File) {
  useMcmaster.setState({ file });
  set({ dialog: 'mcmaster' });
}

/**
 * Opens (or reuses, by window name) McMaster-Carr in its own window beside the studio. The person's own browser keeps
 * their McMaster login and cookies; STEVE never reads that window. Only www.mcmaster.com pages open (mcmasterUrl).
 */
export function openMcmaster(url: string = CATALOG_URL): Window | null {
  const width = Math.round(Math.min(1180, Math.max(720, screen.availWidth * 0.46)));
  const height = Math.round(screen.availHeight * 0.92);
  const left = Math.round(((screen as Screen & { availLeft?: number }).availLeft ?? 0) + screen.availWidth - width);
  const top = Math.round(((screen as Screen & { availTop?: number }).availTop ?? 0) + (screen.availHeight - height) / 2);
  const popup = window.open(mcmasterUrl(url), 'steve-mcmaster', `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
  popup?.focus();
  return popup;
}
