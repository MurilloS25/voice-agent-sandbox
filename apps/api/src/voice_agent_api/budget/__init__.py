"""The daily provider budget: tokens for the model, seconds for speech-to-text.

Only aggregate numbers are ever kept (a UTC day, a category, how much was used and the limit). A
reservation is made before the provider is called and the difference to real usage is settled
afterwards; if the budget cannot be checked the call is refused (fail closed).
"""
