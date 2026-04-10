/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {computed, signal} from '../../src/core';
import {createWatch, ReactiveNode, SIGNAL} from '../../primitives/signals';

import {flushEffects, resetEffects, testingEffect} from './effect_util';

/**
 * Check whether a value is reachable by walking from a ReactiveNode's
 * `producers` linked list through all link fields (producer, consumer,
 * prevConsumer, nextConsumer, nextProducer). This is a generic graph
 * reachability check that doesn't assume a specific data-structure layout.
 */
function isReachableFromProducerLinks(node: ReactiveNode, target: object): boolean {
  const visited = new Set<object>();
  const queue: object[] = [];

  let link: any = (node as any).producers;
  while (link !== undefined) {
    queue.push(link);
    link = link.nextProducer;
  }

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const c = current as any;
    for (const field of ['prevConsumer', 'nextConsumer', 'consumer', 'producer']) {
      if (c[field] !== undefined && c[field] !== null && typeof c[field] === 'object') {
        if (!visited.has(c[field])) {
          queue.push(c[field]);
        }
      }
    }
  }
  return false;
}

describe('signal graph: destroyed consumers should be GC-eligible', () => {
  afterEach(() => {
    resetEffects();
  });

  it('should not retain a destroyed effect via a non-live computed that reads the same producer', () => {
    // Scenario that reproduces the real-world leak:
    //   1. Source signal S (long-lived, like ApplicationEnvironmentService.environmentSignal)
    //   2. An effect E reads S (like a view's ReactiveLViewConsumer)
    //   3. A computed C also reads S, with no readers (like AttachmentApiService.urls)
    //   4. E is destroyed
    //   5. E's reactive node should NOT be reachable from C's producer links.
    //
    // Before the fix, C's producer link to S had its prevConsumer field eagerly
    // set to the tail of S's consumer list at link-creation time. Since C is not
    // live, producerAddLiveConsumer was skipped, leaving a dangling prevConsumer
    // reference into S's consumer list. When E was later destroyed, the dangling
    // pointer was not patched, keeping E reachable from C.

    const source = signal(0);
    const sourceNode = source[SIGNAL] as ReactiveNode;

    // Create an always-live consumer (effect) that reads the source signal.
    let effectNode: ReactiveNode | undefined;
    const destroy = testingEffect(() => {
      source();
    });
    flushEffects();

    // Grab the effect's reactive node from source's consumer list.
    let link: any = (sourceNode as any).consumers;
    while (link !== undefined) {
      effectNode = link.consumer;
      link = link.nextConsumer;
    }
    expect(effectNode).toBeDefined();

    // Create a non-live computed that also reads the source.
    const derived = computed(() => source() + 1);
    derived();

    const derivedNode = derived[SIGNAL] as ReactiveNode;

    // Destroy the effect.
    destroy();

    // The destroyed effect's node must not be reachable from the computed's
    // producer links. If it is, the effect (and everything it retains — its
    // closure, captured view, DOM, etc.) can never be garbage collected.
    expect(isReachableFromProducerLinks(derivedNode, effectNode!)).toBe(false);
  });

  it('should not accumulate reachable nodes across create/destroy cycles', () => {
    const source = signal(0);
    const derived = computed(() => source() + 1);
    derived();

    const derivedNode = derived[SIGNAL] as ReactiveNode;
    const previousNodes: ReactiveNode[] = [];

    for (let i = 0; i < 5; i++) {
      const destroy = testingEffect(() => {
        source();
      });
      flushEffects();

      // Capture the effect node before destroying.
      let effectNode: ReactiveNode | undefined;
      let link: any = (source[SIGNAL] as any).consumers;
      while (link !== undefined) {
        effectNode = link.consumer;
        link = link.nextConsumer;
      }

      destroy();
      previousNodes.push(effectNode!);
    }

    // None of the destroyed effect nodes should be reachable.
    for (let i = 0; i < previousNodes.length; i++) {
      expect(isReachableFromProducerLinks(derivedNode, previousNodes[i]))
        .withContext(`cycle ${i}`)
        .toBe(false);
    }
  });

  it('should still propagate changes through computed chains with live consumers', () => {
    const source = signal(1);
    const double = computed(() => source() * 2);
    const quadruple = computed(() => double() * 2);

    let lastValue = 0;
    const destroyEffect = testingEffect(() => {
      lastValue = quadruple();
    });
    flushEffects();
    expect(lastValue).toBe(4);

    source.set(3);
    flushEffects();
    expect(lastValue).toBe(12);

    destroyEffect();
  });

  it('should still allow computed signals to function correctly', () => {
    const firstName = signal('John');
    const lastName = signal('Doe');
    const fullName = computed(() => `${firstName()} ${lastName()}`);

    expect(fullName()).toBe('John Doe');

    firstName.set('Jane');
    expect(fullName()).toBe('Jane Doe');

    lastName.set('Smith');
    expect(fullName()).toBe('Jane Smith');
  });
});
