import { describe, it, expect } from 'vitest';
import {
  encodeSDP,
  decodeSDP,
  buildSignalMessage,
  parseSignalMessage,
  buildWebSocketUrl,
  createViewer,
  MAX_BACKOFF,
  METADATA_TIMEOUT,
  DISCONNECT_GRACE,
  INITIAL_BACKOFF,
} from '../public/jetkvm-video.js';

// --- SDP Encoding / Decoding ---

describe('encodeSDP', () => {
  it('returns base64(JSON.stringify(description))', () => {
    const desc = { type: 'offer', sdp: 'v=0\r\n...' };
    const encoded = encodeSDP(desc);
    const decoded = JSON.parse(atob(encoded));
    expect(decoded).toEqual(desc);
  });

  it('round-trips through decodeSDP', () => {
    const desc = { type: 'answer', sdp: 'v=0\r\nsome-sdp-data' };
    expect(decodeSDP(encodeSDP(desc))).toEqual(desc);
  });

  it('handles special characters in SDP', () => {
    const desc = { type: 'offer', sdp: 'a=ice-ufrag:abc+/=\r\n' };
    expect(decodeSDP(encodeSDP(desc))).toEqual(desc);
  });
});

describe('decodeSDP', () => {
  it('decodes a base64 string to an object', () => {
    const original = { type: 'answer', sdp: 'v=0\r\n' };
    const base64 = btoa(JSON.stringify(original));
    expect(decodeSDP(base64)).toEqual(original);
  });

  it('throws on invalid base64', () => {
    expect(() => decodeSDP('not-valid-base64!!!')).toThrow();
  });

  it('throws on valid base64 but invalid JSON', () => {
    const base64 = btoa('not json');
    expect(() => decodeSDP(base64)).toThrow();
  });
});

// --- Signaling Messages ---

describe('buildSignalMessage', () => {
  it('builds an offer message', () => {
    const msg = buildSignalMessage('offer', { sd: 'abc123' });
    const parsed = JSON.parse(msg);
    expect(parsed).toEqual({ type: 'offer', data: { sd: 'abc123' } });
  });

  it('builds an ICE candidate message', () => {
    const candidate = {
      candidate: 'candidate:1 1 udp 2130706431 192.168.1.1 12345 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    const msg = buildSignalMessage('new-ice-candidate', candidate);
    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe('new-ice-candidate');
    expect(parsed.data).toEqual(candidate);
  });

  it('handles null data', () => {
    const msg = buildSignalMessage('offer', null);
    const parsed = JSON.parse(msg);
    expect(parsed).toEqual({ type: 'offer', data: null });
  });
});

describe('parseSignalMessage', () => {
  it('parses a valid JSON string', () => {
    const raw = JSON.stringify({ type: 'device-metadata', data: { deviceVersion: '0.5.3' } });
    const msg = parseSignalMessage(raw);
    expect(msg.type).toBe('device-metadata');
    expect(msg.data.deviceVersion).toBe('0.5.3');
  });

  it('parses an answer message with raw base64 data', () => {
    const base64 = btoa(JSON.stringify({ type: 'answer', sdp: 'v=0\r\n' }));
    const raw = JSON.stringify({ type: 'answer', data: base64 });
    const msg = parseSignalMessage(raw);
    expect(msg.type).toBe('answer');
    expect(typeof msg.data).toBe('string');
  });

  it('returns null for invalid JSON', () => {
    expect(parseSignalMessage('not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSignalMessage('')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseSignalMessage(undefined)).toBeNull();
  });
});

// --- WebSocket URL ---

describe('buildWebSocketUrl', () => {
  it('builds ws:// URL for http: pages', () => {
    const url = buildWebSocketUrl('10.0.0.100', 'http:');
    expect(url).toBe('ws://10.0.0.100/webrtc/signaling/client');
  });

  it('builds wss:// URL for https: pages', () => {
    const url = buildWebSocketUrl('10.0.0.100', 'https:');
    expect(url).toBe('wss://10.0.0.100/webrtc/signaling/client');
  });

  it('preserves custom port in host', () => {
    const url = buildWebSocketUrl('10.0.0.100:8080', 'http:');
    expect(url).toBe('ws://10.0.0.100:8080/webrtc/signaling/client');
  });

  it('works with hostname', () => {
    const url = buildWebSocketUrl('jetkvm.local', 'http:');
    expect(url).toBe('ws://jetkvm.local/webrtc/signaling/client');
  });

  it('always uses /webrtc/signaling/client path', () => {
    const url = buildWebSocketUrl('10.0.0.1', 'http:');
    expect(url).toContain('/webrtc/signaling/client');
  });
});

// --- Constants ---

describe('constants', () => {
  it('MAX_BACKOFF is 30 seconds', () => {
    expect(MAX_BACKOFF).toBe(30000);
  });

  it('INITIAL_BACKOFF is 1 second', () => {
    expect(INITIAL_BACKOFF).toBe(1000);
  });

  it('METADATA_TIMEOUT is 10 seconds', () => {
    expect(METADATA_TIMEOUT).toBe(10000);
  });

  it('DISCONNECT_GRACE is 5 seconds', () => {
    expect(DISCONNECT_GRACE).toBe(5000);
  });

  it('MAX_BACKOFF >= INITIAL_BACKOFF', () => {
    expect(MAX_BACKOFF).toBeGreaterThanOrEqual(INITIAL_BACKOFF);
  });
});

// --- SDP Protocol Compliance ---

describe('JetKVM protocol compliance', () => {
  it('offer SDP is wrapped in {sd} object', () => {
    const desc = { type: 'offer', sdp: 'v=0\r\n' };
    const sd = encodeSDP(desc);
    const msg = JSON.parse(buildSignalMessage('offer', { sd }));
    expect(msg.type).toBe('offer');
    expect(msg.data).toHaveProperty('sd');
    expect(typeof msg.data.sd).toBe('string');
    // Verify the sd can be decoded back
    expect(decodeSDP(msg.data.sd)).toEqual(desc);
  });

  it('answer data is a raw base64 string (not wrapped in object)', () => {
    // Simulate what JetKVM device sends back
    const answerDesc = { type: 'answer', sdp: 'v=0\r\nanswer-sdp' };
    const rawBase64 = btoa(JSON.stringify(answerDesc));
    const deviceMsg = { type: 'answer', data: rawBase64 };

    // Verify the answer data is a string, not an object
    expect(typeof deviceMsg.data).toBe('string');
    // Verify we can decode it
    const decoded = decodeSDP(deviceMsg.data);
    expect(decoded).toEqual(answerDesc);
  });

  it('offer and answer SDP encoding are symmetric', () => {
    const offerDesc = { type: 'offer', sdp: 'v=0\r\noffer' };
    const answerDesc = { type: 'answer', sdp: 'v=0\r\nanswer' };

    // Both use the same encoding
    const offerEncoded = encodeSDP(offerDesc);
    const answerEncoded = encodeSDP(answerDesc);

    expect(decodeSDP(offerEncoded)).toEqual(offerDesc);
    expect(decodeSDP(answerEncoded)).toEqual(answerDesc);
  });

  it('ICE candidate message has correct structure', () => {
    const candidate = {
      candidate: 'candidate:1 1 udp 2130706431 192.168.1.1 12345 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    const msg = JSON.parse(buildSignalMessage('new-ice-candidate', candidate));
    expect(msg.type).toBe('new-ice-candidate');
    expect(msg.data.candidate).toContain('candidate:');
    expect(msg.data.sdpMid).toBe('0');
    expect(msg.data.sdpMLineIndex).toBe(0);
  });
});

// --- createViewer requires host ---

describe('createViewer', () => {
  it('requires host parameter', () => {
    expect(() => createViewer({ videoElement: {}, pageProtocol: 'http:' })).toThrow();
  });

  it('requires videoElement parameter', () => {
    expect(() => createViewer({ host: '10.0.0.1', pageProtocol: 'http:' })).toThrow();
  });
});
