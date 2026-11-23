function svg(size: number, body: string): string {
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function iconVolumeOn(size = 15): string {
  return svg(
    size,
    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19.1 5a10 10 0 0 1 0 14"/>'
  );
}

export function iconVolumeOff(size = 15): string {
  return svg(
    size,
    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>'
  );
}

export function iconSearch(size = 15): string {
  return svg(size, '<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/>');
}

export function iconShare(size = 14): string {
  return svg(
    size,
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>'
  );
}

export function iconSun(size = 15): string {
  return svg(
    size,
    '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/>'
  );
}

export function iconMoon(size = 15): string {
  return svg(size, '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>');
}

export function iconHelp(size = 15): string {
  return svg(
    size,
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.8.9c0 1.6-2.3 2.1-2.3 3.4"/><line x1="12" y1="17.2" x2="12.01" y2="17.2"/>'
  );
}

export function iconMenu(size = 16): string {
  return svg(
    size,
    '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>'
  );
}

export function iconClose(size = 14): string {
  return svg(size, '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');
}

export function iconPlus(size = 18): string {
  return svg(size, '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>');
}

export function iconSmile(size = 18): string {
  return svg(
    size,
    '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4 4 0 0 0 7 0"/><line x1="9" y1="9.5" x2="9.01" y2="9.5"/><line x1="15" y1="9.5" x2="15.01" y2="9.5"/>'
  );
}

export function iconSend(size = 14): string {
  return svg(size, '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>');
}

export function iconPhone(size = 18): string {
  return svg(
    size,
    '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.8.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>'
  );
}

export function iconPhoneOff(size = 14): string {
  return svg(
    size,
    '<path d="M10.7 13.3a16 16 0 0 0 2.6 2l1.4-1.4a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1"/><path d="M5.1 10.6A19.7 19.7 0 0 1 2.1 4.1 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9"/><line x1="22" y1="2" x2="2" y2="22"/>'
  );
}

export function iconMic(size = 18): string {
  return svg(
    size,
    '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>'
  );
}

export function iconMicOff(size = 14): string {
  return svg(
    size,
    '<path d="M9 9v3a3 3 0 0 0 5.1 2.1"/><path d="M15 9.3V5a3 3 0 0 0-5.7-1.3"/><path d="M5 10v2a7 7 0 0 0 12 4.9"/><path d="M19 10v2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="2" x2="22" y2="22"/>'
  );
}

export function iconVideo(size = 14): string {
  return svg(
    size,
    '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>'
  );
}

export function iconVideoOff(size = 14): string {
  return svg(
    size,
    '<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="M10.7 5H14a2 2 0 0 1 2 2v3.3l1 1L23 7v10"/><line x1="2" y1="2" x2="22" y2="22"/>'
  );
}

export function iconRefresh(size = 14): string {
  return svg(
    size,
    '<path d="M21 12a9 9 0 0 0-15.5-6.3L3 8"/><polyline points="3 3 3 8 8 8"/><path d="M3 12a9 9 0 0 0 15.5 6.3L21 16"/><polyline points="16 16 21 16 21 21"/>'
  );
}

export function iconMonitor(size = 14): string {
  return svg(
    size,
    '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'
  );
}

export function iconEye(size = 14): string {
  return svg(
    size,
    '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'
  );
}

export function iconEyeOff(size = 14): string {
  return svg(
    size,
    '<path d="M17.9 17.9A10.9 10.9 0 0 1 12 19c-6.4 0-10-7-10-7a18.5 18.5 0 0 1 5.1-5.9"/><path d="M9.9 5.2A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a18.5 18.5 0 0 1-2.2 3.2"/><line x1="2" y1="2" x2="22" y2="22"/>'
  );
}

export function iconPaperclip(size = 18): string {
  return svg(
    size,
    '<path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.1a2 2 0 0 1-2.8-2.8l8.5-8.5"/>'
  );
}

export function iconGamepad(size = 18): string {
  return svg(
    size,
    '<rect x="3" y="3" width="18" height="18" rx="3"/><line x1="8.5" y1="8.5" x2="8.51" y2="8.5"/><line x1="15.5" y1="8.5" x2="15.51" y2="8.5"/><line x1="12" y1="12" x2="12.01" y2="12"/><line x1="8.5" y1="15.5" x2="8.51" y2="15.5"/><line x1="15.5" y1="15.5" x2="15.51" y2="15.5"/>'
  );
}

export function iconDownload(size = 13): string {
  return svg(
    size,
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'
  );
}

export function iconExternalLink(size = 13): string {
  return svg(
    size,
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'
  );
}

export function iconMaximize(size = 14): string {
  return svg(
    size,
    '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>'
  );
}

export function iconMinimize(size = 14): string {
  return svg(
    size,
    '<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>'
  );
}

export function iconExpand(size = 14): string {
  return svg(
    size,
    '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'
  );
}

export function iconArrowLeft(size = 13): string {
  return svg(size, '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>');
}

export function iconArrowDown(size = 16): string {
  return svg(size, '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>');
}

export function iconSmilePlus(size = 14): string {
  return svg(
    size,
    '<path d="M21 12a9 9 0 1 1-9-9"/><path d="M8.5 14.5a4 4 0 0 0 7 0"/><line x1="9" y1="9.5" x2="9.01" y2="9.5"/><line x1="15" y1="9.5" x2="15.01" y2="9.5"/><line x1="18.5" y1="3" x2="18.5" y2="8"/><line x1="16" y1="5.5" x2="21" y2="5.5"/>'
  );
}

export function iconCopy(size = 14): string {
  return svg(
    size,
    '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
  );
}

export function iconReply(size = 14): string {
  return svg(
    size,
    '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'
  );
}

export function iconTrash(size = 14): string {
  return svg(
    size,
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'
  );
}

export const REVCHAT_ASCII_BANNER = `  ____ _____ _   _  ____ _   _    _  _____ 
 |  _ \\ ____| | | |/ ___| | | |  / \\|_   _|
 | |_) |  _| | | | | |   | |_| | / _ \\ | |  
 |  _ &lt;| |___\\ \\_/ / |___|  _  |/ ___ \\| |  
 |_| \\_\\_____|\\___/ \\____|_| |_/_/   \\_\\_|  
      (ง ͡° ͜ʖ ͡°)ง🏴   🚩( ͡° ͜ʖ ͡°)🚩`;
