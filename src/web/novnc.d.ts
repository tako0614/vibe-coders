declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      url: string,
      options?: { credentials?: { password?: string } },
    );
    scaleViewport: boolean;
    resizeSession: boolean;
    disconnect(): void;
  }
}
