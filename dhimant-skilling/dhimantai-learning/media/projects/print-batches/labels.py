"""Label batches for the print desk."""


class Batch:
    labels = []

    def add(self, label):
        self.labels.append(label)
        return len(self.labels)
