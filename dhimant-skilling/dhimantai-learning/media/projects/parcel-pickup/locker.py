"""Pickup counter for reserved parcels."""

def collect(zone, oversized, log):
    counter = "freight" if oversized else zone
    log.append(counter)
    return counter

def lookup(zone, oversized, log):
    return collect(zone, oversized, log)
