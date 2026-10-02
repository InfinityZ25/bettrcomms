#include <stdint.h>
typedef struct bc_input_tap bc_input_tap;
int bc_input_permission(void);
int bc_input_request_permission(void);
bc_input_tap *bc_input_create(uintptr_t handle, const int *keys, const int *buttons, int count);
void bc_input_run(bc_input_tap *tap);
void bc_input_stop(bc_input_tap *tap);
void bc_input_destroy(bc_input_tap *tap);
int bc_input_down(int key, int button);
