import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { SessionSummary } from '../api/types';
import { EmptyState, PageHeader, Section } from '../components/ui';
import { formatDuration } from '../content/format';
import { modeLabels } from '../content/labels';

const POLL_MS = 2000;
const PRE_ROLL_MS = 1500;
const TIMESLICE_MS = 1000;
const RECENT = 5;
const MIME_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

type CameraState = 'off' | 'starting' | 'recording' | 'failed';

interface Take {
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
}

interface Highlight {
  id: string;
  title: string;
  attempt: number;
  url: string;
  startSec: number;
  fileName: string;
  session: SessionSummary;
}

interface AttemptLog {
  id: string;
  title: string;
  attempt: number;
  highlight: boolean;
}

function supportedMime(): string | undefined {
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function startTake(stream: MediaStream): Take {
  const mimeType = supportedMime();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  recorder.start(TIMESLICE_MS);
  return { recorder, chunks, startedAt: Date.now() };
}

function finishTake(take: Take): Promise<Blob> {
  return new Promise((resolve) => {
    take.recorder.onstop = () =>
      resolve(new Blob(take.chunks, { type: take.recorder.mimeType || 'video/webm' }));
    take.recorder.stop();
  });
}

async function openCamera(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch {
    return navigator.mediaDevices.getUserMedia({ video: true });
  }
}

function isLevelMode(session: SessionSummary): boolean {
  return session.mode === 'level_color' || session.mode === 'level_score';
}

function titleOf(session: SessionSummary): string {
  if (session.training) {
    return `${session.training.title ?? 'Treino'} · etapa ${session.training.stepIndex + 1}`;
  }
  return isLevelMode(session) ? `${modeLabels[session.mode]} · nível ${session.level}` : modeLabels[session.mode];
}

function attemptKey(session: SessionSummary): string {
  return session.training
    ? `training:${session.training.id}:${session.training.stepIndex}`
    : `${session.mode}:${session.level}`;
}

function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function CameraPage() {
  const [state, setState] = useState<CameraState>('off');
  const [error, setError] = useState<string | null>(null);
  const [takeStartedAt, setTakeStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [log, setLog] = useState<AttemptLog[]>([]);

  const previewRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const takeRef = useRef<Take | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const attemptsRef = useRef<Map<string, number>>(new Map());
  const busyRef = useRef(false);
  const urlsRef = useRef<string[]>([]);

  function stopCamera() {
    takeRef.current?.recorder.stop();
    takeRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setTakeStartedAt(null);
    setState('off');
  }

  useEffect(
    () => () => {
      takeRef.current?.recorder.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  async function startCamera() {
    setState('starting');
    setError(null);

    try {
      const recent = await api.mySessions({ limit: RECENT, offset: 0 });
      recent.items.forEach((session) => seenRef.current.add(session.id));

      const stream = await openCamera();
      streamRef.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
      }
      takeRef.current = startTake(stream);
      setTakeStartedAt(takeRef.current.startedAt);
      setState('recording');
    } catch (cause) {
      setError(
        cause instanceof DOMException
          ? 'Não foi possível abrir a câmera. Libere o acesso à webcam no navegador e tente de novo.'
          : cause instanceof Error
            ? cause.message
            : 'Algo deu errado.',
      );
      setState('failed');
    }
  }

  async function closeTake(session: SessionSummary, attempt: number) {
    const stream = streamRef.current;
    const previous = takeRef.current;

    if (!stream || !previous) {
      return;
    }

    takeRef.current = startTake(stream);
    setTakeStartedAt(takeRef.current.startedAt);
    const blob = await finishTake(previous);
    const title = titleOf(session);

    if (!session.cleared || !(isLevelMode(session) || session.training) || session.offline) {
      return;
    }

    const url = URL.createObjectURL(blob);
    urlsRef.current.push(url);
    const sessionStart = Date.parse(session.playedAt) - session.durationMs - PRE_ROLL_MS;

    setHighlights((current) => [
      {
        id: session.id,
        title,
        attempt,
        url,
        startSec: Math.max(0, (sessionStart - previous.startedAt) / 1000),
        fileName: `smash-highlight-${slug(title)}-tentativa-${attempt}.webm`,
        session,
      },
      ...current,
    ]);
  }

  async function poll() {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;

    try {
      const recent = await api.mySessions({ limit: RECENT, offset: 0 });
      const fresh = recent.items
        .filter((session) => !seenRef.current.has(session.id))
        .sort((a, b) => Date.parse(a.playedAt) - Date.parse(b.playedAt));

      const entries = fresh.map((session) => {
        seenRef.current.add(session.id);
        const key = attemptKey(session);
        const attempt = (attemptsRef.current.get(key) ?? 0) + 1;
        attemptsRef.current.set(key, attempt);
        return { session, attempt };
      });

      if (entries.length === 0) {
        return;
      }

      setLog((current) => [
        ...entries
          .map(({ session, attempt }) => ({
            id: session.id,
            title: titleOf(session),
            attempt,
            highlight: session.cleared && (isLevelMode(session) || session.training !== null) && !session.offline,
          }))
          .reverse(),
        ...current,
      ]);

      const last = entries[entries.length - 1];
      await closeTake(last.session, last.attempt);
    } catch {
      return;
    } finally {
      busyRef.current = false;
    }
  }

  useEffect(() => {
    if (state !== 'recording') {
      return;
    }
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(clock);
    };
  }, [state]);

  return (
    <div className="stack-lg">
      <PageHeader
        eyebrow="Jogador"
        title="Câmera e highlights"
        description="A webcam grava cada tentativa. Errou, o clipe é descartado e uma nova gravação começa; passou de nível, o clipe daquela tentativa vira o seu highlight. Entre com a mesma conta do app."
        actions={
          state === 'recording' ? (
            <button type="button" className="btn btn-secondary" onClick={stopCamera}>
              Desligar câmera
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={state === 'starting'}
              onClick={() => void startCamera()}
            >
              {state === 'starting' ? 'Abrindo câmera…' : 'Ligar câmera'}
            </button>
          )
        }
      />

      {error ? <div className="alert alert-danger">{error}</div> : null}

      <div className="camera-grid">
        <div className="card stack">
          <div className="row-between">
            <strong>Ao vivo</strong>
            {state === 'recording' && takeStartedAt ? (
              <span className="badge badge-danger">
                <span className="rec-dot" aria-hidden="true" /> Gravando · {formatDuration(now - takeStartedAt)}
              </span>
            ) : (
              <span className="badge">Câmera desligada</span>
            )}
          </div>
          <video ref={previewRef} className="camera-video" autoPlay muted playsInline />
        </div>

        <div className="card stack">
          <strong>Tentativas</strong>
          {log.length === 0 ? (
            <p className="muted small">
              {state === 'recording'
                ? 'Aguardando o fim de uma tentativa no app…'
                : 'Ligue a câmera e jogue um nível no app.'}
            </p>
          ) : (
            <ul className="attempt-log">
              {log.map((entry) => (
                <li key={entry.id} className="row-between">
                  <span>
                    Tentativa {entry.attempt} · {entry.title}
                  </span>
                  {entry.highlight ? (
                    <span className="badge badge-accent">Highlight salvo</span>
                  ) : (
                    <span className="badge badge-warning">Clipe descartado</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Section title="Highlights">
        {highlights.length === 0 ? (
          <div className="card">
            <EmptyState title="Nenhum highlight ainda.">
              Passe de nível no app com a câmera ligada para gerar o primeiro.
            </EmptyState>
          </div>
        ) : (
          <div className="highlight-grid">
            {highlights.map((highlight, index) => (
              <div key={highlight.id} className="card stack">
                <div className="stack-sm">
                  <span className="eyebrow">Tentativa {highlight.attempt}</span>
                  <strong>{highlight.title} concluído</strong>
                  <span className="muted small">
                    {highlight.session.hits} acertos · {highlight.session.score} pontos ·{' '}
                    {formatDuration(highlight.session.durationMs)}
                  </span>
                </div>
                <video
                  className="camera-video"
                  src={highlight.url}
                  controls
                  autoPlay={index === 0}
                  playsInline
                  onLoadedMetadata={(event) => {
                    event.currentTarget.currentTime = highlight.startSec;
                  }}
                />
                <a className="btn btn-secondary btn-sm" href={highlight.url} download={highlight.fileName}>
                  Baixar vídeo
                </a>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
