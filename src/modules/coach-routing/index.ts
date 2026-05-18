/**
 * Coach routing switch — handler per la system action `switch_routing_mode`.
 *
 * Il MCP tool workout-coach emette questa action quando l'utente apre/chiude
 * una sessione di allenamento. L'effetto è invertire i pattern di engagement
 * delle wiring di Router e Coach sul messaging group di provenienza, così
 * che durante la workout il Coach diventi il default su Telegram (mantenendo
 * @Andy/@Coder/@Researcher/@Router raggiungibili) e poi tutto torni come
 * prima a `finish_workout`.
 *
 * Gli ID delle wiring non sono hardcoded: la lookup è per
 * (messaging_group_id, agent_group_name) → row, così il modulo resta robusto
 * ai cambi futuri.
 */
import { getDb } from '../../db/connection.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';

const PATTERNS = {
  routerNormal: '^(?!.*@(Andy|Coder|Researcher|Coach)\\b)',
  routerWorkout: '@Router',
  coachNormal: '@Coach',
  coachWorkout: '^(?!.*@(Andy|Coder|Researcher|Router)\\b)',
};

function findWiringByGroupName(messagingGroupId: string, groupName: string): { id: string } | undefined {
  return getDb()
    .prepare(
      `SELECT mga.id AS id FROM messaging_group_agents mga
       JOIN agent_groups ag ON ag.id = mga.agent_group_id
       WHERE mga.messaging_group_id = ? AND ag.name = ? COLLATE NOCASE`,
    )
    .get(messagingGroupId, groupName) as { id: string } | undefined;
}

function updatePattern(wiringId: string, pattern: string): void {
  getDb().prepare('UPDATE messaging_group_agents SET engage_pattern = ? WHERE id = ?').run(pattern, wiringId);
}

registerDeliveryAction('switch_routing_mode', async (content, session) => {
  const mode = content.mode as string;
  if (mode !== 'workout' && mode !== 'normal') {
    log.warn('switch_routing_mode: invalid mode', { mode });
    return;
  }
  const mgId = session.messaging_group_id;
  if (!mgId) {
    log.warn('switch_routing_mode: session has no messaging_group_id', { sessionId: session.id });
    return;
  }
  const router = findWiringByGroupName(mgId, 'Router');
  const coach = findWiringByGroupName(mgId, 'Coach');
  if (!router || !coach) {
    log.warn('switch_routing_mode: missing Router or Coach wiring on this messaging group', {
      mgId,
      hasRouter: !!router,
      hasCoach: !!coach,
    });
    return;
  }
  if (mode === 'workout') {
    updatePattern(router.id, PATTERNS.routerWorkout);
    updatePattern(coach.id, PATTERNS.coachWorkout);
    log.info('Coach routing → workout mode', { mgId });
  } else {
    updatePattern(router.id, PATTERNS.routerNormal);
    updatePattern(coach.id, PATTERNS.coachNormal);
    log.info('Coach routing → normal mode', { mgId });
  }
});
