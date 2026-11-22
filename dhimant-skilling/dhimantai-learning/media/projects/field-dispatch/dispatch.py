"""Dispatch board for field service tickets."""


class DispatchDesk:
    def __init__(self, board):
        self.board = board

    def assign(self, urgent, distance):
        if urgent:
            crew = "rapid"
        elif distance > 20:
            crew = "regional"
        else:
            crew = "local"
        self.board.append(crew)
        return crew

    def estimate(self, urgent, distance):
        return self.assign(urgent, distance)
