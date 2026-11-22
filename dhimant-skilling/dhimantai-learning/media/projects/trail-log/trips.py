"""Stop lists for a walking guide."""


def record_stop(name, stops=[]):
    stops.append(name)
    return list(stops)
