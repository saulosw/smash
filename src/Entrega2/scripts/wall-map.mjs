#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const COLORS = {
  1: 'ÂMBAR',
  2: 'AZUL',
  3: 'VERMELHO',
  4: 'VERMELHO',
  5: 'ÂMBAR',
  6: 'AZUL',
};
const ROWS = { 1: 'cima', 2: 'baixo' };
const COLUMNS = { 1: 'esquerda', 2: 'meio', 3: 'direita' };

function appEnv() {
  try {
    const text = readFileSync(new URL('../frontend/.env', import.meta.url), 'utf8');
    return Object.fromEntries(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  } catch {
    return {};
  }
}

const env = appEnv();
const url = process.env.WALL_URL ?? env.EXPO_PUBLIC_DEVICE_URL ?? 'ws://192.168.4.1:81';
const token = process.env.WALL_TOKEN ?? env.EXPO_PUBLIC_DEVICE_TOKEN ?? '';

const found = new Map();

function cell(id) {
  const hit = found.get(id);
  const label = `A${id} ${COLORS[id]}`.padEnd(12);
  return hit ? `[x] ${label}` : `[ ] ${label}`;
}

function printWall() {
  console.log('\n  Parede vista de frente (onde cada placa DEVE ficar):');
  console.log(`  ${cell(1)}  ${cell(2)}  ${cell(3)}`);
  console.log(`  ${cell(4)}  ${cell(5)}  ${cell(6)}`);
  console.log(`  ${found.size}/6 placas identificadas\n`);
}

function onImpact(impact) {
  const id = impact.alvo;
  const color = COLORS[id];

  if (!color) {
    console.log(`Alvo desconhecido: ${JSON.stringify(impact)}`);
    return;
  }

  const strongest = Math.max(found.get(id) ?? 0, impact.intensidade);
  found.set(id, strongest);

  console.log('────────────────────────────────────────────');
  console.log(`  Você bateu no A${id}  (intensidade ${impact.intensidade})`);
  console.log(`  Essa placa é ${color} e fica na linha de ${ROWS[impact.linha]}, ${COLUMNS[impact.coluna]}.`);
  printWall();
}

console.log(`Conectando em ${url} ...`);
console.log('Feche o app antes: a parede só aceita um cliente por vez.');

const socket = new WebSocket(`${url.replace(/\/$/, '')}/?token=${encodeURIComponent(token)}`);

socket.on('open', () => {
  console.log('Conectado. Bata em uma placa por vez. Ctrl+C para sair.');
  printWall();
});

socket.on('message', (data) => {
  let frame;
  try {
    frame = JSON.parse(data.toString());
  } catch {
    return;
  }

  if (frame.tipo === 'erro') {
    console.log(`A parede recusou: ${frame.detalhe}`);
  } else if (frame.tipo === 'hello') {
    console.log(`Parede ${frame.parede} · protocolo ${frame.protocolo} · ${frame.alvos} alvos`);
  } else if (typeof frame.alvo === 'number') {
    onImpact(frame);
  }
});

socket.on('error', (error) => {
  console.log(`Não consegui conectar: ${error.message}`);
  console.log('Confira se o PC está no Wi-Fi da parede e se WALL_URL/WALL_TOKEN estão certos.');
});

socket.on('close', () => {
  console.log('Conexão encerrada.');
  process.exit(0);
});
