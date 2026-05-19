#include "dictation.h"
#include "message_keys.h"
#include <string.h>

static DictationSession *s_session = NULL;
static DictationDoneHandler s_on_done = NULL;
static DictationFailHandler s_on_fail = NULL;
static char s_captured[MAX_UTTERANCE];

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
