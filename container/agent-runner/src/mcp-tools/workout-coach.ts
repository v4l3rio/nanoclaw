/**
 * Workout Coach MCP tools.
 *
 * Registers only if /coach-data/coach.db is reachable — gated so non-coach
 * containers (Router, Andy, Coder, Researcher) never see these tools.
 *
 * Storage lives in a per-host SQLite mounted from data/coach/coach.db.
 */
import fs from 'fs';
import path from 'path';
import { Database } from 'bun:sqlite';

import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const COACH_DIR = '/coach-data';
const COACH_DB_PATH = path.join(COACH_DIR, 'coach.db');
const SCHEMA_FILE = '/app/mcp-tools/workout-coach.schema.sql';

function log(msg: string): void {
  console.error(`[workout-coach] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;
  if (!fs.existsSync(COACH_DIR)) {
    throw new Error(`coach data dir missing: ${COACH_DIR}`);
  }
  db = new Database(COACH_DB_PATH);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;');
  if (fs.existsSync(SCHEMA_FILE)) {
    db.exec(fs.readFileSync(SCHEMA_FILE, 'utf-8'));
  }
  return db;
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function epleyE1RM(weight: number, reps: number): number {
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

function findExercise(input: string): { id: number; name: string; muscle_group: string | null } | null {
  const d = getDb();
  const norm = input.trim().toLowerCase();
  const direct = d
    .query<{ id: number; name: string; muscle_group: string | null }, [string]>(
      'SELECT id, name, muscle_group FROM exercises WHERE LOWER(name) = ?',
    )
    .get(norm);
  if (direct) return direct;
  const all = d
    .query<{ id: number; name: string; muscle_group: string | null; aliases: string }, []>(
      'SELECT id, name, muscle_group, aliases FROM exercises',
    )
    .all();
  for (const row of all) {
    try {
      const aliases = JSON.parse(row.aliases) as string[];
      if (aliases.some((a) => a.toLowerCase() === norm)) {
        return { id: row.id, name: row.name, muscle_group: row.muscle_group };
      }
    } catch {
      /* skip malformed aliases */
    }
  }
  return null;
}

function getActiveWorkout(): { id: number; started_at: string } | null {
  return (
    getDb()
      .query<{ id: number; started_at: string }, []>(
        'SELECT id, started_at FROM workouts WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1',
      )
      .get() ?? null
  );
}

function getActiveProgram(): { id: number; name: string } | null {
  return (
    getDb()
      .query<{ id: number; name: string }, []>('SELECT id, name FROM programs WHERE is_active = 1 LIMIT 1')
      .get() ?? null
  );
}

function emitSwitchRoutingMode(mode: 'workout' | 'normal'): void {
  writeMessageOut({
    id: generateId(),
    kind: 'system',
    content: JSON.stringify({ action: 'switch_routing_mode', mode }),
  });
}

function isPr(exerciseId: number, weight: number, reps: number): { kind: string; previous?: number } | null {
  const d = getDb();
  const sameReps = d
    .query<{ best: number | null }, [number, number]>(
      'SELECT MAX(weight_kg) AS best FROM sets WHERE exercise_id = ? AND reps = ?',
    )
    .get(exerciseId, reps);
  const e1rmRow = d
    .query<{ best: number | null }, [number]>(
      'SELECT MAX(e1rm_kg) AS best FROM sets WHERE exercise_id = ?',
    )
    .get(exerciseId);
  const newE1rm = epleyE1RM(weight, reps);

  if (sameReps && (sameReps.best === null || weight > sameReps.best)) {
    return { kind: `peso a ${reps} reps`, previous: sameReps.best ?? undefined };
  }
  if (e1rmRow && (e1rmRow.best === null || newE1rm > e1rmRow.best)) {
    return { kind: `e1RM`, previous: e1rmRow.best ?? undefined };
  }
  return null;
}

function inferRpeFromNote(note: string | undefined): number | null {
  if (!note) return null;
  const n = note.toLowerCase();
  if (/non riusciv|cedimento|al limite|massimo|tirat[oa] fuori/.test(n)) return 10;
  if (/molto stanc|fatic|durissim|durissima/.test(n)) return 9;
  if (/stanc/.test(n)) return 8.5;
  if (/potevo farne (una|un'altra|un altra|2|due|tre)|facile|tranquill/.test(n)) return 7;
  if (/leggera|riscaldamento|warmup/.test(n)) return 5;
  return null;
}

const startWorkout: McpToolDefinition = {
  tool: {
    name: 'start_workout',
    description:
      'Apre una nuova sessione di allenamento. Da chiamare quando l\'utente dice "inizio allenamento" o simili. Cambia anche il routing Telegram in workout mode.',
    inputSchema: {
      type: 'object',
      properties: {
        day_name: { type: 'string', description: 'Es. "Push A", se la scheda ha più giorni' },
        bodyweight_kg: { type: 'number' },
        sleep_h: { type: 'number' },
        energy: { type: 'number', description: '1–10' },
        note: { type: 'string' },
      },
    },
  },
  async handler(args) {
    const current = getActiveWorkout();
    if (current) {
      return err(
        `Workout già aperta (id=${current.id} dal ${current.started_at}). Chiama finish_workout prima di iniziarne un'altra.`,
      );
    }
    let programDayId: number | null = null;
    const dayName = args.day_name as string | undefined;
    if (dayName) {
      const prog = getActiveProgram();
      if (prog) {
        const row = getDb()
          .query<{ id: number }, [number, string]>(
            'SELECT id FROM program_days WHERE program_id = ? AND LOWER(day_name) = LOWER(?)',
          )
          .get(prog.id, dayName);
        if (row) programDayId = row.id;
      }
    }
    const res = getDb()
      .query<{ id: number }, [number | null, number | null, number | null, number | null, string | null]>(
        `INSERT INTO workouts (program_day_id, bodyweight_kg, sleep_h, energy, session_note)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        programDayId,
        (args.bodyweight_kg as number) ?? null,
        (args.sleep_h as number) ?? null,
        (args.energy as number) ?? null,
        (args.note as string) ?? null,
      );
    emitSwitchRoutingMode('workout');
    log(`workout started id=${res?.id}`);
    return ok(
      `Workout #${res?.id} aperta${dayName ? ` (${dayName})` : ''}. Routing Telegram → workout mode (tutti i messaggi non taggati arrivano al Coach).`,
    );
  },
};

const logSet: McpToolDefinition = {
  tool: {
    name: 'log_set',
    description:
      'Registra una serie. Richiede esercizio, peso (kg), reps. RPE/RIR/note opzionali. Se l\'esercizio non esiste, chiama prima add_exercise. Inferisce RPE dalla nota se non passato.',
    inputSchema: {
      type: 'object',
      properties: {
        exercise: { type: 'string', description: 'Nome o alias' },
        weight_kg: { type: 'number' },
        reps: { type: 'number' },
        rpe: { type: 'number' },
        rir: { type: 'number' },
        rest_s: { type: 'number' },
        note: { type: 'string', description: 'Es. "ero stanco", "potevo farne un\'altra"' },
      },
      required: ['exercise', 'weight_kg', 'reps'],
    },
  },
  async handler(args) {
    const w = getActiveWorkout();
    if (!w) return err('Nessuna workout attiva. Chiama start_workout prima.');
    const ex = findExercise(args.exercise as string);
    if (!ex) return err(`Esercizio "${args.exercise}" non trovato. Chiama add_exercise per crearlo.`);
    const weight = args.weight_kg as number;
    const reps = args.reps as number;
    const note = (args.note as string) ?? null;
    const rpe = (args.rpe as number) ?? inferRpeFromNote(note ?? undefined) ?? null;
    const rir = (args.rir as number) ?? null;
    const rest = (args.rest_s as number) ?? null;
    const e1rm = epleyE1RM(weight, reps);

    const prevSet = getDb()
      .query<{ n: number }, [number, number]>(
        'SELECT COALESCE(MAX(set_number), 0) AS n FROM sets WHERE workout_id = ? AND exercise_id = ?',
      )
      .get(w.id, ex.id);
    const setNum = (prevSet?.n ?? 0) + 1;

    const pr = isPr(ex.id, weight, reps);

    getDb()
      .query(
        `INSERT INTO sets (workout_id, exercise_id, set_number, weight_kg, reps, rpe, rir, rest_s, note_post_set, e1rm_kg)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(w.id, ex.id, setNum, weight, reps, rpe, rir, rest, note, e1rm);

    let msg = `Set ${setNum} ${ex.name}: ${weight}kg × ${reps}${rpe ? ` (RPE ${rpe})` : ''} ✓ (e1RM ${e1rm}kg)`;
    if (pr) {
      msg += ` 🏆 NUOVO PB (${pr.kind}${pr.previous ? `, prima: ${pr.previous}kg` : ''})`;
    }
    return ok(msg);
  },
};

const finishWorkout: McpToolDefinition = {
  tool: {
    name: 'finish_workout',
    description:
      'Chiude la sessione attiva. Riprende il routing normale (Telegram torna al Router come default).',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Note sulla sessione complessiva' },
      },
    },
  },
  async handler(args) {
    const w = getActiveWorkout();
    if (!w) return err('Nessuna workout attiva.');
    const note = (args.note as string) ?? null;
    getDb()
      .query('UPDATE workouts SET ended_at = ?, session_note = COALESCE(?, session_note) WHERE id = ?')
      .run(nowIso(), note, w.id);

    const sets = getDb()
      .query<{ total: number; volume: number }, [number]>(
        `SELECT COUNT(*) AS total, COALESCE(SUM(weight_kg * reps), 0) AS volume
         FROM sets WHERE workout_id = ?`,
      )
      .get(w.id);
    const prs = getDb()
      .query<{ ex: string; w: number; r: number }, [number]>(
        `SELECT e.name AS ex, s.weight_kg AS w, s.reps AS r FROM sets s
         JOIN exercises e ON e.id = s.exercise_id WHERE s.workout_id = ?
         AND s.e1rm_kg = (SELECT MAX(e1rm_kg) FROM sets WHERE exercise_id = s.exercise_id)`,
      )
      .all(w.id);

    emitSwitchRoutingMode('normal');

    let msg = `Workout #${w.id} chiusa. ${sets?.total ?? 0} serie totali, volume ${Math.round((sets?.volume ?? 0))}kg·rep. Routing → normale.`;
    if (prs.length) {
      msg += `\n🏆 PB battuti: ${prs.map((p) => `${p.ex} ${p.w}×${p.r}`).join(', ')}`;
    }
    return ok(msg);
  },
};

const addExercise: McpToolDefinition = {
  tool: {
    name: 'add_exercise',
    description: 'Aggiunge un esercizio al catalogo. Chiamare se findExercise fallisce.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        muscle_group: { type: 'string', description: 'Es. petto, dorso, gambe, spalle, braccia, core' },
        equipment: { type: 'string', description: 'Es. bilanciere, manubri, macchina, corpo libero' },
        is_compound: { type: 'boolean' },
        aliases: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = (args.name as string).trim();
    const existing = findExercise(name);
    if (existing) return ok(`Esiste già: ${existing.name} (id=${existing.id})`);
    const aliases = JSON.stringify((args.aliases as string[]) ?? []);
    const res = getDb()
      .query<{ id: number }, [string, string, string | null, string | null, number]>(
        `INSERT INTO exercises (name, aliases, muscle_group, equipment, is_compound)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        name,
        aliases,
        (args.muscle_group as string) ?? null,
        (args.equipment as string) ?? null,
        args.is_compound ? 1 : 0,
      );
    return ok(`Esercizio aggiunto: ${name} (id=${res?.id})`);
  },
};

const getPr: McpToolDefinition = {
  tool: {
    name: 'get_pr',
    description: 'Personal best per un esercizio: max peso a ogni rep range e best e1RM.',
    inputSchema: {
      type: 'object',
      properties: { exercise: { type: 'string' } },
      required: ['exercise'],
    },
  },
  async handler(args) {
    const ex = findExercise(args.exercise as string);
    if (!ex) return err(`Esercizio "${args.exercise}" non trovato.`);
    const rows = getDb()
      .query<{ reps: number; w: number; date: string }, [number]>(
        `SELECT reps, MAX(weight_kg) AS w, MAX(logged_at) AS date FROM sets WHERE exercise_id = ?
         GROUP BY reps ORDER BY reps`,
      )
      .all(ex.id);
    if (!rows.length) return ok(`Nessun set registrato per ${ex.name}.`);
    const e1rm = getDb()
      .query<{ best: number }, [number]>('SELECT MAX(e1rm_kg) AS best FROM sets WHERE exercise_id = ?')
      .get(ex.id);
    const lines = rows.map((r) => `  ${r.reps} reps → ${r.w}kg`);
    return ok(`PB ${ex.name}:\n${lines.join('\n')}\nBest e1RM: ${e1rm?.best ?? 'n/a'}kg`);
  },
};

const getHistory: McpToolDefinition = {
  tool: {
    name: 'get_history',
    description: 'Storico recente di un esercizio.',
    inputSchema: {
      type: 'object',
      properties: {
        exercise: { type: 'string' },
        limit: { type: 'number', description: 'Default 10' },
      },
      required: ['exercise'],
    },
  },
  async handler(args) {
    const ex = findExercise(args.exercise as string);
    if (!ex) return err(`Esercizio "${args.exercise}" non trovato.`);
    const limit = (args.limit as number) ?? 10;
    const rows = getDb()
      .query<
        { date: string; setn: number; w: number; r: number; rpe: number | null; note: string | null },
        [number, number]
      >(
        `SELECT date(s.logged_at) AS date, s.set_number AS setn, s.weight_kg AS w, s.reps AS r,
                s.rpe AS rpe, s.note_post_set AS note
         FROM sets s WHERE s.exercise_id = ?
         ORDER BY s.logged_at DESC LIMIT ?`,
      )
      .all(ex.id, limit);
    if (!rows.length) return ok(`Nessuno storico per ${ex.name}.`);
    const lines = rows.map(
      (r) => `${r.date} S${r.setn}: ${r.w}×${r.r}${r.rpe ? ` RPE${r.rpe}` : ''}${r.note ? ` — "${r.note}"` : ''}`,
    );
    return ok(`Storico ${ex.name} (ultimi ${rows.length}):\n${lines.join('\n')}`);
  },
};

const getProgression: McpToolDefinition = {
  tool: {
    name: 'get_progression',
    description:
      'Trend dei carichi e RPE sull\'esercizio. Restituisce dati grezzi per la tua analisi del progresso.',
    inputSchema: {
      type: 'object',
      properties: { exercise: { type: 'string' }, last_n: { type: 'number' } },
      required: ['exercise'],
    },
  },
  async handler(args) {
    const ex = findExercise(args.exercise as string);
    if (!ex) return err(`Esercizio "${args.exercise}" non trovato.`);
    const n = (args.last_n as number) ?? 10;
    const sessions = getDb()
      .query<
        { date: string; topw: number; topr: number; vol: number; avgrpe: number | null },
        [number, number]
      >(
        `SELECT date(s.logged_at) AS date,
                MAX(s.weight_kg) AS topw,
                MAX(s.reps) AS topr,
                SUM(s.weight_kg * s.reps) AS vol,
                AVG(s.rpe) AS avgrpe
         FROM sets s WHERE s.exercise_id = ?
         GROUP BY date(s.logged_at) ORDER BY date DESC LIMIT ?`,
      )
      .all(ex.id, n);
    if (!sessions.length) return ok(`Nessuna sessione per ${ex.name}.`);
    const lines = sessions.map(
      (s) =>
        `${s.date} top=${s.topw}×${s.topr} vol=${Math.round(s.vol)}${s.avgrpe ? ` RPE~${s.avgrpe.toFixed(1)}` : ''}`,
    );
    return ok(`Progressione ${ex.name}:\n${lines.join('\n')}`);
  },
};

const suggestToday: McpToolDefinition = {
  tool: {
    name: 'suggest_today',
    description: 'Suggerisce carichi/reps per il giorno corrente della scheda attiva basandosi sullo storico.',
    inputSchema: {
      type: 'object',
      properties: { day_name: { type: 'string' } },
    },
  },
  async handler(args) {
    const prog = getActiveProgram();
    if (!prog) return ok('Nessuna scheda attiva. Usa upload_program e set_active_program.');
    const dayName = args.day_name as string | undefined;
    let day: { id: number; day_name: string } | null = null;
    if (dayName) {
      day =
        getDb()
          .query<{ id: number; day_name: string }, [number, string]>(
            'SELECT id, day_name FROM program_days WHERE program_id = ? AND LOWER(day_name) = LOWER(?)',
          )
          .get(prog.id, dayName) ?? null;
    } else {
      day =
        getDb()
          .query<{ id: number; day_name: string }, [number]>(
            'SELECT id, day_name FROM program_days WHERE program_id = ? ORDER BY day_order LIMIT 1',
          )
          .get(prog.id) ?? null;
    }
    if (!day) return err('Giorno scheda non trovato.');
    const exs = getDb()
      .query<
        {
          name: string;
          exid: number;
          ts: number | null;
          tr: string | null;
          trpe: number | null;
          rest: number | null;
          strat: string;
        },
        [number]
      >(
        `SELECT e.name AS name, e.id AS exid, pe.target_sets AS ts, pe.target_reps AS tr,
                pe.target_rpe AS trpe, pe.target_rest_s AS rest, pe.progression_strategy AS strat
         FROM program_exercises pe JOIN exercises e ON e.id = pe.exercise_id
         WHERE pe.program_day_id = ? ORDER BY pe.ex_order`,
      )
      .all(day.id);
    if (!exs.length) return ok(`Nessun esercizio configurato per ${day.day_name}.`);
    const lines: string[] = [`Suggerimenti per ${day.day_name}:`];
    for (const e of exs) {
      const last = getDb()
        .query<{ w: number; r: number; rpe: number | null }, [number]>(
          `SELECT weight_kg AS w, reps AS r, rpe FROM sets WHERE exercise_id = ?
           ORDER BY logged_at DESC LIMIT 1`,
        )
        .get(e.exid);
      const targetRepsStr = e.tr ?? '?';
      let suggestion: string;
      if (!last) {
        suggestion = `prima volta — parti con un peso di riscaldamento, target ${e.ts ?? '?'}×${targetRepsStr}`;
      } else {
        let next = last.w;
        if (e.strat === 'linear') next = last.w + (e.name.match(/panca|squat|stacco|deadlift/i) ? 2.5 : 1);
        else if (e.strat === 'double' && last.r >= Number((e.tr ?? '0').split('-').pop() ?? 0))
          next = last.w + (e.name.match(/panca|squat|stacco|deadlift/i) ? 2.5 : 1);
        suggestion = `ultimo ${last.w}×${last.r}${last.rpe ? ` RPE${last.rpe}` : ''} → prova ${next}kg per ${e.ts ?? '?'}×${targetRepsStr}`;
      }
      lines.push(`• ${e.name}: ${suggestion}`);
    }
    return ok(lines.join('\n'));
  },
};

const uploadProgram: McpToolDefinition = {
  tool: {
    name: 'upload_program',
    description:
      'Crea una nuova scheda. Riceve dati strutturati: nome scheda + lista giorni con esercizi (sets, reps target, strategy). Imposta is_active=true se active=true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        active: { type: 'boolean' },
        microcycle_weeks: { type: 'number' },
        notes: { type: 'string' },
        days: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              day_name: { type: 'string' },
              exercises: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    target_sets: { type: 'number' },
                    target_reps: { type: 'string' },
                    target_rpe: { type: 'number' },
                    target_rest_s: { type: 'number' },
                    progression_strategy: {
                      type: 'string',
                      enum: ['linear', 'double', 'rpe-based', 'free'],
                    },
                  },
                  required: ['name'],
                },
              },
            },
            required: ['day_name', 'exercises'],
          },
        },
      },
      required: ['name', 'days'],
    },
  },
  async handler(args) {
    const d = getDb();
    const active = args.active === true;
    if (active) d.exec('UPDATE programs SET is_active = 0');
    const prog = d
      .query<{ id: number }, [string, number, string | null, number]>(
        `INSERT INTO programs (name, microcycle_weeks, notes, is_active) VALUES (?, ?, ?, ?) RETURNING id`,
      )
      .get(
        args.name as string,
        (args.microcycle_weeks as number) ?? 4,
        (args.notes as string) ?? null,
        active ? 1 : 0,
      );
    if (!prog) return err('Insert program fallito.');
    const days = args.days as Array<{
      day_name: string;
      exercises: Array<{
        name: string;
        target_sets?: number;
        target_reps?: string;
        target_rpe?: number;
        target_rest_s?: number;
        progression_strategy?: string;
      }>;
    }>;
    let dayOrder = 0;
    for (const day of days) {
      const dayRow = d
        .query<{ id: number }, [number, string, number]>(
          'INSERT INTO program_days (program_id, day_name, day_order) VALUES (?, ?, ?) RETURNING id',
        )
        .get(prog.id, day.day_name, dayOrder++);
      if (!dayRow) continue;
      let exOrder = 0;
      for (const ex of day.exercises) {
        let exercise = findExercise(ex.name);
        if (!exercise) {
          const created = d
            .query<{ id: number; name: string; muscle_group: string | null }, [string, string]>(
              "INSERT INTO exercises (name, aliases) VALUES (?, '[]') RETURNING id, name, muscle_group",
            )
            .get(ex.name, '[]');
          exercise = created!;
        }
        d.query(
          `INSERT INTO program_exercises (program_day_id, exercise_id, ex_order, target_sets, target_reps, target_rpe, target_rest_s, progression_strategy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          dayRow.id,
          exercise.id,
          exOrder++,
          ex.target_sets ?? null,
          ex.target_reps ?? null,
          ex.target_rpe ?? null,
          ex.target_rest_s ?? null,
          ex.progression_strategy ?? 'rpe-based',
        );
      }
    }
    return ok(
      `Scheda "${args.name}" creata (id=${prog.id}) con ${days.length} giorni${active ? ' e impostata come attiva' : ''}.`,
    );
  },
};

const listPrograms: McpToolDefinition = {
  tool: {
    name: 'list_programs',
    description: 'Elenca le schede salvate.',
    inputSchema: { type: 'object', properties: {} },
  },
  async handler() {
    const rows = getDb()
      .query<{ id: number; name: string; active: number; start: string; end: string | null }, []>(
        'SELECT id, name, is_active AS active, started_on AS start, ended_on AS end FROM programs ORDER BY id DESC',
      )
      .all();
    if (!rows.length) return ok('Nessuna scheda salvata.');
    return ok(
      rows
        .map((r) => `#${r.id} ${r.name} (${r.start}${r.end ? ` → ${r.end}` : ''})${r.active ? ' [ACTIVE]' : ''}`)
        .join('\n'),
    );
  },
};

const setActiveProgram: McpToolDefinition = {
  tool: {
    name: 'set_active_program',
    description: 'Imposta una scheda come attiva (e disattiva le altre).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  async handler(args) {
    const d = getDb();
    d.exec('UPDATE programs SET is_active = 0');
    d.query('UPDATE programs SET is_active = 1 WHERE id = ?').run(args.id as number);
    return ok(`Scheda #${args.id} attiva.`);
  },
};

const weeklySummary: McpToolDefinition = {
  tool: {
    name: 'weekly_summary',
    description: 'Riepilogo ultima settimana: volume per gruppo muscolare, frequenza, PB.',
    inputSchema: {
      type: 'object',
      properties: { week_offset: { type: 'number', description: '0 = settimana corrente, -1 = scorsa' } },
    },
  },
  async handler(args) {
    const offset = (args.week_offset as number) ?? 0;
    const since = new Date();
    since.setDate(since.getDate() + offset * 7 - 7);
    const sinceStr = since.toISOString().slice(0, 10);
    const d = getDb();
    const sessions = d
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM workouts WHERE date(started_at) >= ?',
      )
      .get(sinceStr);
    const byGroup = d
      .query<{ mg: string; vol: number }, [string]>(
        `SELECT COALESCE(e.muscle_group, 'other') AS mg, SUM(s.weight_kg * s.reps) AS vol
         FROM sets s JOIN exercises e ON e.id = s.exercise_id JOIN workouts w ON w.id = s.workout_id
         WHERE date(w.started_at) >= ? GROUP BY mg ORDER BY vol DESC`,
      )
      .all(sinceStr);
    if (!sessions || sessions.n === 0) return ok(`Nessuna sessione dal ${sinceStr}.`);
    const lines = [`Riepilogo da ${sinceStr}: ${sessions.n} sessioni.`, 'Volume per gruppo:'];
    for (const g of byGroup) lines.push(`  ${g.mg}: ${Math.round(g.vol)}kg·rep`);
    return ok(lines.join('\n'));
  },
};

const enterWorkoutMode: McpToolDefinition = {
  tool: {
    name: 'enter_workout_mode',
    description:
      'Forza il routing Telegram in workout mode (Coach diventa default). Solitamente già chiamato da start_workout — usalo solo se hai bisogno di forzare lo switch.',
    inputSchema: { type: 'object', properties: {} },
  },
  async handler() {
    emitSwitchRoutingMode('workout');
    return ok('Switch → workout mode richiesto.');
  },
};

const exitWorkoutMode: McpToolDefinition = {
  tool: {
    name: 'exit_workout_mode',
    description:
      'Forza il routing Telegram in normal mode (Router torna default). Solitamente già chiamato da finish_workout.',
    inputSchema: { type: 'object', properties: {} },
  },
  async handler() {
    emitSwitchRoutingMode('normal');
    return ok('Switch → normal mode richiesto.');
  },
};

if (fs.existsSync(COACH_DIR)) {
  try {
    getDb();
    registerTools([
      startWorkout,
      logSet,
      finishWorkout,
      addExercise,
      getPr,
      getHistory,
      getProgression,
      suggestToday,
      uploadProgram,
      listPrograms,
      setActiveProgram,
      weeklySummary,
      enterWorkoutMode,
      exitWorkoutMode,
    ]);
    log('tools registered');
  } catch (e) {
    log(`init skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}
