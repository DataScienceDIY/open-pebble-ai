#include "dictation.h"
#include "message_keys.h"
#include <string.h>

static DictationSession *s_session = NULL;
static DictationDoneHandler s_on_done = NULL;
static DictationFailHandler s_on_fail = NULL;
static char s_captured[MAX_UTTERANCE];

#ifdef OWUI_DEBUG_FAKE_DICTATION
// Emulator inner-loop short-circuit: cycles through canned utterances so the
// state-machine harness can drive multi-turn flows by repeatedly clicking
// SELECT. Turn 1 plants a fact, turn 2 asks about it, turn 3 is a short
// closer. Wraps on overflow; reset via dictation_debug_reset().
static const char *const debug_utterances[] = {
    "remember the number forty two",
    "what number did i tell you",
    "say goodbye in one word",
};
static unsigned debug_idx = 0;
#endif

static void dictation_callback(DictationSession *session,
                               DictationSessionStatus status,
                               char *transcription,
                               void *context) {
  if (status == DictationSessionStatusSuccess && transcription) {
    strncpy(s_captured, transcription, sizeof(s_captured) - 1);
    s_captured[sizeof(s_captured) - 1] = '\0';
    if (s_on_done) s_on_done(s_captured);
  } else {
    if (s_on_fail) s_on_fail((int)status);
  }

  // Per design §8(a): destroy and recreate per turn to free heap for the
  // response buffer during STATE_WAITING.
  if (s_session) {
    dictation_session_destroy(s_session);
    s_session = NULL;
  }
}

#ifdef OWUI_DEBUG_FAKE_DICTATION
void dictation_debug_reset(void) { debug_idx = 0; }
#endif

void dictation_init(DictationDoneHandler on_done, DictationFailHandler on_fail) {
  s_on_done = on_done;
  s_on_fail = on_fail;
  s_captured[0] = '\0';
}

void dictation_deinit(void) {
  if (s_session) {
    dictation_session_destroy(s_session);
    s_session = NULL;
  }
}

void dictation_start(void) {
#ifdef OWUI_DEBUG_FAKE_DICTATION
  const char *u = debug_utterances[debug_idx % (sizeof(debug_utterances) /
                                                sizeof(debug_utterances[0]))];
  debug_idx++;
  strncpy(s_captured, u, sizeof(s_captured) - 1);
  s_captured[sizeof(s_captured) - 1] = '\0';
  if (s_on_done) s_on_done(s_captured);
  return;
#endif

  if (s_session) {
    dictation_session_destroy(s_session);
    s_session = NULL;
  }
  s_session = dictation_session_create(MAX_UTTERANCE, dictation_callback, NULL);
  if (s_session) {
    dictation_session_start(s_session);
  } else if (s_on_fail) {
    s_on_fail(-1);
  }
}
