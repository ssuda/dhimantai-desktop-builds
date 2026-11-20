/** A local viewfinder. Only the still chosen by the learner enters the attachment tray. */
export class NotebookCamera {
  private dialog?: HTMLDialogElement;
  private stream?: MediaStream;

  constructor(private attach: (photo: File) => void, private report: (message: string) => void) {}

  close() {
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = undefined;
    this.dialog?.remove();
    this.dialog = undefined;
  }

  async open() {
    if (this.dialog) return;
    const dialog = document.createElement('dialog');
    this.dialog = dialog;
    dialog.className = 'notebook-camera';
    dialog.setAttribute('aria-labelledby', 'camera-title');
    dialog.innerHTML = '<h2 id="camera-title">Take a photo</h2><video muted autoplay playsinline></video>'
      + '<p role="status">Opening camera…</p><div><button type="button" data-cancel>Cancel</button>'
      + '<button type="button" data-capture disabled>Take photo</button></div>';
    const preview = dialog.querySelector('video')!;
    const capture = dialog.querySelector<HTMLButtonElement>('[data-capture]')!;
    const status = dialog.querySelector('p')!;
    const fail = (message: string) => {
      if (this.dialog !== dialog) return;
      this.close();
      this.report(message);
    };
    dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick = () => this.close();
    dialog.oncancel = event => { event.preventDefault(); this.close(); };
    preview.onloadeddata = () => {
      capture.disabled = !preview.videoWidth || !preview.videoHeight;
      if (!capture.disabled) status.textContent = 'Review the photo in your message before sending.';
    };
    capture.onclick = () => {
      if (capture.disabled) return;
      capture.disabled = true;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = preview.videoWidth;
        canvas.height = preview.videoHeight;
        const context = canvas.getContext('2d');
        if (!context || !canvas.width || !canvas.height) throw new Error();
        context.drawImage(preview, 0, 0);
        this.stream?.getTracks().forEach(track => track.stop());
        this.stream = undefined;
        canvas.toBlob(blob => {
          if (this.dialog !== dialog) return;
          if (!blob?.size) { fail('Could not capture the photo. Try again or attach a photo.'); return; }
          this.close();
          this.attach(new File([blob], 'Camera photo.jpg', {type: blob.type}));
        }, 'image/jpeg', 0.92);
      } catch {
        fail('Could not capture the photo. Try again or attach a photo.');
      }
    };
    document.body.append(dialog);
    try {
      dialog.showModal();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}},
      });
      if (this.dialog !== dialog) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error();
      track.addEventListener('ended', () => fail('The camera stopped. Try again or attach a photo.'), {once: true});
      preview.srcObject = stream;
      await preview.play();
    } catch (error) {
      fail(error instanceof Error && error.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access or attach a photo.'
        : 'Camera unavailable. Check your camera or attach a photo.');
    }
  }
}
