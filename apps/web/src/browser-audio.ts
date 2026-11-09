import { wsUrl } from './api.js';
function decodeMuLaw(value: number) {
  const x = ~value & 255;
  const n = (((x & 15) << 3) + 132) << ((x >> 4) & 7);
  return (x & 128 ? -(n - 132) : n - 132) / 32768;
}
export class BrowserAudio {
  private context?: AudioContext;
  private socket?: WebSocket;
  private stream?: MediaStream;
  private processor?: ScriptProcessorNode;
  private source?: MediaStreamAudioSourceNode;
  private queueAt = 0;
  private active: AudioBufferSourceNode[] = [];
  private failed = false;
  private connected = false;
  constructor(
    private onStatus: (s: string) => void,
    private onCall: (id: string) => void,
  ) {}
  async start(campaignId: string, simulation: boolean) {
    if (!simulation) {
      this.context = new AudioContext();
      await this.context.resume();
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (error) {
        this.dispose();
        throw error;
      }
      this.source = this.context.createMediaStreamSource(this.stream);
      // ScriptProcessor is broadly supported; no remote code/worklet blobs required. Output stays silent.
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = (e) => {
        if (this.socket?.readyState !== WebSocket.OPEN) return;
        const samples = e.inputBuffer.getChannelData(0),
          ratio = e.inputBuffer.sampleRate / 8000,
          out = new Int16Array(Math.floor(samples.length / ratio));
        // Average each source interval to attenuate aliasing when downsampling microphone audio.
        for (let i = 0; i < out.length; i++) {
          let sum = 0,
            count = 0;
          for (let j = Math.floor(i * ratio); j < Math.floor((i + 1) * ratio); j++) {
            sum += samples[j];
            count++;
          }
          out[i] = Math.round(Math.max(-1, Math.min(1, sum / count)) * 32767);
        }
        this.socket.send(out.buffer);
      };
      this.source.connect(this.processor);
      this.processor.connect(this.context.destination);
    }
    this.socket = new WebSocket(wsUrl(`/ws/browser/${campaignId}`));
    this.socket.onopen = () => this.socket?.send(JSON.stringify({ type: 'start' }));
    this.socket.onclose = () => {
      if (!this.failed)
        this.onStatus(this.connected ? 'Call ended' : 'Connection closed before the call started.');
      this.dispose();
    };
    this.socket.onerror = () => {
      this.failed = true;
      this.onStatus('Connection failed. Check your browser connection and try again.');
    };
    this.socket.onmessage = (e) => {
      const message = JSON.parse(e.data);
      if (message.type === 'ready') this.onStatus(message.note);
      if (message.type === 'started') {
        this.connected = true;
        this.onCall(message.call_id);
        this.onStatus('Connected. Your conversation is ready.');
      }
      if (message.type === 'error') {
        this.failed = true;
        this.onStatus(`Browser test failed: ${message.message}`);
      }
      if (message.type === 'clear') {
        for (const source of this.active) {
          try {
            source.stop();
          } catch {
            /* source already ended */
          }
        }
        this.active = [];
        if (this.context) this.queueAt = this.context.currentTime;
      }
      if (message.type === 'audio' && this.context) {
        const bytes = Uint8Array.from(atob(message.audio), (c) => c.charCodeAt(0)),
          buffer = this.context.createBuffer(1, bytes.length, 8000);
        buffer.getChannelData(0).set(Array.from(bytes, decodeMuLaw));
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.context.destination);
        this.queueAt = Math.max(this.context.currentTime + 0.025, this.queueAt);
        source.start(this.queueAt);
        this.queueAt += buffer.duration;
        this.active.push(source);
        source.onended = () => {
          this.active = this.active.filter((s) => s !== source);
        };
      }
      if (message.type === 'mark')
        setTimeout(
          () => {
            if (this.socket?.readyState === 1)
              this.socket.send(JSON.stringify({ type: 'mark', name: message.name }));
          },
          Math.max(0, (this.queueAt - (this.context?.currentTime ?? 0)) * 1000),
        );
    };
  }
  text(text: string) {
    this.socket?.send(JSON.stringify({ type: 'text', text }));
  }
  end() {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ type: 'end' }));
    this.socket?.close(1000, 'Browser test ended');
    this.dispose();
  }
  private dispose() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.processor?.disconnect();
    this.source?.disconnect();
    if (this.context && this.context.state !== 'closed') void this.context.close();
  }
}
