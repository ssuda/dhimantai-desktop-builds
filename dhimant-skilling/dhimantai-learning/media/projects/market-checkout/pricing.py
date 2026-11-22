"""Checkout prices are integer cents. The receipts list is the sales ledger."""


def checkout(cents, member, receipts):
    total = cents - cents // 10 if member else cents
    receipts.append(total)
    return total


def preview(cents, member, receipts):
    return checkout(cents, member, receipts)
