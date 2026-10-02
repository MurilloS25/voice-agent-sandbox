"""Text agent orchestration (plan 0003).

The model can read business facts and prepare a booking review. It can never write: this
package has no path to `confirm_appointment` or `AppointmentBook.confirm`, and a static test
enforces that. Confirmation stays with the user through the existing signed-proposal flow.
"""
