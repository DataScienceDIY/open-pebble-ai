#pragma once

void ui_response_init(void);
void ui_response_deinit(void);

// Renders every committed Turn from state into chat bubbles. Reads the
// ring directly via state_turn_count / state_turn_at — no parameters.
void ui_response_show(void);
void ui_response_hide(void);
