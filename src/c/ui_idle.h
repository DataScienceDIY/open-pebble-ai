#pragma once

// IDLE and ERROR share one window; the body text and footer flip based on
// state_current() / state_last_error().

void ui_idle_init(void);
void ui_idle_deinit(void);

void ui_idle_show(void);
